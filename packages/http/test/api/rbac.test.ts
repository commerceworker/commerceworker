import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';

const symbolField = (apiId: string, position: number) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});

describe('granular RBAC over HTTP', () => {
  let app: ReturnType<typeof createApp>;
  let editor: Record<string, string>;
  let postId: string;
  let pageId: string;

  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());

    // Model two types; publish both.
    for (const apiId of ['post', 'page']) {
      await app.request(`${M}/content-types`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          apiId,
          name: apiId,
          displayField: 'title',
          fields: [symbolField('title', 0), symbolField('internalNotes', 1)],
        }),
      });
      await app.request(`${M}/content-types/${apiId}/published`, {
        method: 'POST',
        headers: admin,
      });
    }

    // Author + publish one entry per type (with a sensitive field set).
    const mkEntry = async (contentTypeApiId: string) => {
      const res = await app.request(`${M}/entries`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          contentTypeApiId,
          fields: {
            title: { 'en-US': `A ${contentTypeApiId}` },
            internalNotes: { 'en-US': 'secret' },
          },
        }),
      });
      const { entry } = (await res.json()) as { entry: { id: string } };
      await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: admin });
      return entry.id;
    };
    postId = await mkEntry('post');
    pageId = await mkEntry('page');

    // A custom role: full coarse scopes, but content-wise only `post`,
    // no publish action, internalNotes hidden.
    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Post editor',
        scopes: ['content:write', 'content:publish', 'preview:read', 'delivery:read'],
        contentGrants: [
          {
            contentTypeApiId: 'post',
            actions: ['read', 'write'],
            deniedFields: ['internalNotes'],
          },
        ],
      }),
    });
    expect(roleRes.status).toBe(201);
    const role = (await roleRes.json()) as { id: string };

    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };
    editor = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  });

  it('allows granted writes and rejects ungranted types and fields', async () => {
    const ok = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: editor,
      body: JSON.stringify({ contentTypeApiId: 'post', fields: { title: { 'en-US': 'Mine' } } }),
    });
    expect(ok.status).toBe(201);

    const wrongType = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: editor,
      body: JSON.stringify({ contentTypeApiId: 'page', fields: { title: { 'en-US': 'No' } } }),
    });
    expect(wrongType.status).toBe(403);

    const deniedField = await app.request(`${M}/entries/${postId}`, {
      method: 'PUT',
      headers: editor,
      body: JSON.stringify({ fields: { internalNotes: { 'en-US': 'sneaky' } } }),
    });
    expect(deniedField.status).toBe(403);
  });

  it('keeps the fields a writer may not write when it saves, and answers without them', async () => {
    const put = (fields: unknown) =>
      app.request(`${M}/entries/${postId}`, {
        method: 'PUT',
        headers: editor,
        body: JSON.stringify({ fields }),
      });
    const edit = { title: { 'en-US': 'B' } };

    const checked = await app.request(`${M}/entries/validate`, {
      method: 'POST',
      headers: editor,
      body: JSON.stringify({ entryId: postId, fields: edit }),
    });
    expect(checked.status).toBe(200);
    expect(((await checked.json()) as { fields: object }).fields).not.toHaveProperty(
      'internalNotes',
    );

    const saved = await put(edit);
    expect(saved.status, await saved.clone().text()).toBe(200);
    // The writer never sees the field it may not read, even though the save kept it.
    expect(((await saved.json()) as { fields: object }).fields).not.toHaveProperty('internalNotes');
    const asAdmin = (await (
      await app.request(`${M}/entries/${postId}`, { headers: admin })
    ).json()) as { entry: { currentVersion: number }; fields: Record<string, unknown> };
    expect(asAdmin.entry.currentVersion).toBe(2);
    expect(asAdmin.fields).toEqual({
      title: { 'en-US': 'B' },
      internalNotes: { 'en-US': 'secret' },
    });

    // A second save from the writer's own (masked) read keeps it too.
    const reread = (await (
      await app.request(`${M}/entries/${postId}`, { headers: editor })
    ).json()) as { fields: Record<string, unknown> };
    expect((await put({ ...reread.fields, title: { 'en-US': 'C' } })).status).toBe(200);
    const again = (await (
      await app.request(`${M}/entries/${postId}`, { headers: admin })
    ).json()) as { fields: Record<string, unknown> };
    expect(again.fields.internalNotes).toEqual({ 'en-US': 'secret' });
  });

  it('duplicates for a writer without the fields it may not read; the copy keeps them', async () => {
    const res = await app.request(`${M}/entries/${postId}/duplicate`, {
      method: 'POST',
      headers: editor,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const copy = (await res.json()) as {
      entry: { id: string };
      fields: Record<string, unknown>;
    };
    expect(copy.fields).toEqual({ title: { 'en-US': 'A post (copy)' } });

    const asAdmin = (await (
      await app.request(`${M}/entries/${copy.entry.id}`, { headers: admin })
    ).json()) as { fields: Record<string, unknown> };
    expect(asAdmin.fields.internalNotes).toEqual({ 'en-US': 'secret' });
  });

  it('refuses a duplicate without write on the type, and leaves no copy behind', async () => {
    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Post reader',
        scopes: ['content:write', 'preview:read'],
        contentGrants: [{ contentTypeApiId: 'post', actions: ['read'] }],
      }),
    });
    const role = (await roleRes.json()) as { id: string };
    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };
    const reader = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const res = await app.request(`${M}/entries/${postId}/duplicate`, {
      method: 'POST',
      headers: reader,
    });
    expect(res.status).toBe(403);

    // A type the role has no grant for at all is refused the same way.
    const other = await app.request(`${M}/entries/${pageId}/duplicate`, {
      method: 'POST',
      headers: editor,
    });
    expect(other.status).toBe(403);

    const counts = (await (
      await app.request(`${M}/content-types/entry-counts`, { headers: admin })
    ).json()) as { items: { contentType: string; total: number }[] };
    expect(counts.items.find((c) => c.contentType === 'post')?.total).toBe(1);
    expect(counts.items.find((c) => c.contentType === 'page')?.total).toBe(1);
  });

  it('counts entries per content type, leaving out types the role cannot read', async () => {
    type Counts = { items: { contentType: string; total: number; published: number }[] };
    const all = await app.request(`${M}/content-types/entry-counts`, { headers: admin });
    expect(all.status).toBe(200);
    const everything = ((await all.json()) as Counts).items;
    expect(everything.map((c) => c.contentType).sort()).toEqual(['page', 'post']);
    expect(everything.find((c) => c.contentType === 'post')).toMatchObject({
      total: 1,
      published: 1,
    });

    const scoped = await app.request(`${M}/content-types/entry-counts`, { headers: editor });
    expect(((await scoped.json()) as Counts).items.map((c) => c.contentType)).toEqual(['post']);
  });

  it('denies publish despite the coarse content:publish scope', async () => {
    const res = await app.request(`${M}/entries/${postId}/published`, {
      method: 'POST',
      headers: editor,
    });
    expect(res.status).toBe(403);
  });

  it('masks denied fields on management, preview, and delivery reads', async () => {
    const mgmt = (await (
      await app.request(`${M}/entries/${postId}`, { headers: editor })
    ).json()) as { fields: Record<string, unknown> };
    expect(mgmt.fields.title).toBeDefined();
    expect(mgmt.fields.internalNotes).toBeUndefined();

    const preview = (await (
      await app.request('/preview/s1/main/entries', { headers: editor })
    ).json()) as { items: { contentType: string; fields: Record<string, unknown> }[] };
    // Only `post` entries are visible, and the denied field is masked.
    expect(preview.items.every((e) => e.contentType === 'post')).toBe(true);
    expect(preview.items.every((e) => e.fields.internalNotes === undefined)).toBe(true);

    const delivery = (await (
      await app.request('/delivery/s1/main/entries', { headers: editor })
    ).json()) as { items: { contentType: string }[] };
    expect(delivery.items.map((e) => e.contentType)).toEqual(['post']);

    const deniedGet = await app.request(`/delivery/s1/main/entries/${pageId}`, {
      headers: editor,
    });
    expect(deniedGet.status).toBe(403);
  });

  it('pages the preview list over readable types only: no cursor names a hidden entry', async () => {
    // The `page` entry would end the first page in title order ("A page" < "A post").
    const first = (await (
      await app.request('/preview/s1/main/entries?order=fields.title&limit=1', { headers: editor })
    ).json()) as { items: { id: string }[]; nextCursor?: string };
    expect(first.items.map((e) => e.id)).toEqual([postId]);
    expect(first.nextCursor).toBeUndefined();
  });

  it('refuses queries that would reveal a hidden field, on every read surface', async () => {
    for (const url of [
      // A filter answers "does internalNotes match?" even though the value is masked.
      '/delivery/s1/main/entries?content_type=post&fields.internalNotes[match]=secret',
      '/preview/s1/main/entries?content_type=post&fields.internalNotes=secret',
      // Ordering by it leaks its order; free-text search runs over every field.
      '/delivery/s1/main/entries?content_type=post&order=fields.internalNotes',
      '/delivery/s1/main/entries?content_type=post&query=secret',
      // Naming no type is judged against every type's rules.
      '/delivery/s1/main/entries?fields.internalNotes[exists]=true',
    ]) {
      expect((await app.request(url, { headers: editor })).status, url).toBe(403);
    }
    // Queries over readable fields still work.
    const ok = await app.request(
      '/delivery/s1/main/entries?content_type=post&fields.title[match]=post&order=-sys.publishedAt',
      { headers: editor },
    );
    expect(ok.status).toBe(200);
    // The admin token has no field rules.
    expect(
      (
        await app.request('/delivery/s1/main/entries?content_type=post&query=secret', {
          headers: admin,
        })
      ).status,
    ).toBe(200);
  });

  it('kind-based keys and the admin token are unaffected', async () => {
    const full = (await (
      await app.request(`${M}/entries/${postId}`, { headers: admin })
    ).json()) as { fields: Record<string, unknown> };
    expect(full.fields.internalNotes).toBeDefined();
  });

  it('enforces granular RBAC on version-history reads', async () => {
    // Granted type: version snapshot is readable but the denied field is masked.
    const versions = (await (
      await app.request(`${M}/entries/${postId}/versions`, { headers: editor })
    ).json()) as { items: { fields: Record<string, unknown> }[] };
    expect(versions.items.length).toBeGreaterThan(0);
    expect(versions.items.every((v) => v.fields.title !== undefined)).toBe(true);
    expect(versions.items.every((v) => v.fields.internalNotes === undefined)).toBe(true);

    // Ungranted type: version history is forbidden, not leaked.
    const pageVersions = await app.request(`${M}/entries/${pageId}/versions`, { headers: editor });
    expect(pageVersions.status).toBe(403);

    // A single version snapshot of an ungranted type is likewise forbidden.
    const pageVersion = await app.request(`${M}/entries/${pageId}/versions/1`, { headers: editor });
    expect(pageVersion.status).toBe(403);
  });

  it('applies write authorization when restoring a version', async () => {
    // Restoring an ungranted type is rejected.
    const restorePage = await app.request(`${M}/entries/${pageId}/versions/1/restore`, {
      method: 'POST',
      headers: editor,
    });
    expect(restorePage.status).toBe(403);

    // Restoring a granted entry whose snapshot includes a denied field is rejected
    // (it would otherwise resurrect internalNotes past the field rule).
    const restorePost = await app.request(`${M}/entries/${postId}/versions/1/restore`, {
      method: 'POST',
      headers: editor,
    });
    expect(restorePost.status).toBe(403);
  });

  it('masks embedded entries at include depth (fields, grants, and stubs)', async () => {
    // A story links to a post (granted, with a denied field) and a page
    // (ungranted): the embed must be masked / reverted to a stub respectively.
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        apiId: 'story',
        name: 'story',
        displayField: 'title',
        fields: [
          symbolField('title', 0),
          {
            apiId: 'refPost',
            name: 'refPost',
            type: 'Link',
            linkType: 'Entry',
            localized: false,
            required: false,
            position: 1,
          },
          {
            apiId: 'refPage',
            name: 'refPage',
            type: 'Link',
            linkType: 'Entry',
            localized: false,
            required: false,
            position: 2,
          },
        ],
      }),
    });
    await app.request(`${M}/content-types/story/published`, { method: 'POST', headers: admin });
    const created = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        contentTypeApiId: 'story',
        fields: {
          title: { 'en-US': 'A story' },
          refPost: { 'en-US': { id: postId, linkType: 'Entry' } },
          refPage: { 'en-US': { id: pageId, linkType: 'Entry' } },
        },
      }),
    });
    const { entry } = (await created.json()) as { entry: { id: string } };
    await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: admin });

    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Story reader',
        scopes: ['delivery:read'],
        contentGrants: [
          { contentTypeApiId: 'story', actions: ['read'] },
          { contentTypeApiId: 'post', actions: ['read'], deniedFields: ['internalNotes'] },
          // no grant on 'page'
        ],
      }),
    });
    const role = (await roleRes.json()) as { id: string };
    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cda', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };

    type Embedded = { id: string; contentType?: string; fields?: Record<string, unknown> };
    const fetchStory = async (bearer: string, query: string) => {
      const res = await app.request(`/delivery/s1/main/entries/${entry.id}?${query}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { fields: Record<string, unknown> };
    };

    // Locale-flattened read: post embed masked, page embed reverted to stub.
    const flat = await fetchStory(token, 'include=1&locale=en-US');
    const refPost = flat.fields.refPost as Embedded;
    expect(refPost.fields?.title).toBe('A post');
    expect(refPost.fields?.internalNotes).toBeUndefined();
    expect(flat.fields.refPage).toEqual({ id: pageId, linkType: 'Entry' });

    // Unflattened read: embeds sit inside per-locale maps — still reached.
    const mapped = await fetchStory(token, 'include=1');
    const mappedPost = (mapped.fields.refPost as Record<string, Embedded>)['en-US'];
    expect(mappedPost?.fields?.internalNotes).toBeUndefined();
    expect((mapped.fields.refPage as Record<string, unknown>)['en-US']).toEqual({
      id: pageId,
      linkType: 'Entry',
    });

    // The full-access key still gets complete embeds (no over-masking).
    const full = await fetchStory('cda', 'include=1&locale=en-US');
    expect((full.fields.refPost as Embedded).fields?.internalNotes).toBe('secret');
    expect((full.fields.refPage as Embedded).fields?.title).toBe('A page');
  });
});
