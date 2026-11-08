import type { ApiConfig } from '@commerceworker/platform/config';
import { createManagementClient } from '@commerceworker/sdk-management';
import { describe, expect, it } from 'vitest';
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

const M = '/spaces/s1/environments/main';
const title = {
  apiId: 'title',
  name: 'Title',
  type: 'Symbol' as const,
  localized: false,
  required: false,
  position: 0,
};

function setup() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  const fetch = ((url: string | URL | Request, init?: RequestInit) =>
    app.request(String(url), init)) as typeof globalThis.fetch;
  const cma = createManagementClient({
    baseUrl: '',
    space: 's1',
    environment: 'main',
    token: 'admin',
    fetch,
  });
  const request = (method: string, path: string, body?: unknown, token = 'cma') =>
    app.request(`${M}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** A cma key whose role holds `scopes`, and, with `grants`, only those content types. */
  const roleKey = async (scopes: string[], grants?: string[]) => {
    const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
    const role = (await (
      await app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          name: `Role ${scopes.join(' ')} ${grants?.join(' ') ?? ''}`,
          scopes,
          ...(grants
            ? {
                contentGrants: grants.map((t) => ({
                  contentTypeApiId: t,
                  actions: ['read', 'write', 'publish'],
                })),
              }
            : {}),
        }),
      })
    ).json()) as { id: string };
    const { token } = (await (
      await app.request('/spaces/s1/api-keys', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ kind: 'cma', roleId: role.id }),
      })
    ).json()) as { token: string };
    return token;
  };
  return { ctx: wired.ctx, cma, request, roleKey };
}

/** Deleting and cloning a content type over HTTP and the management SDK. */
describe('content type delete and clone over the API', () => {
  it('clones, reports dependents, refuses a delete with a reason, and deletes when free', async () => {
    const { ctx, cma, request } = setup();
    await cma.contentTypes.create({
      apiId: 'author',
      name: 'Author',
      displayField: 'title',
      fields: [title],
    });
    await cma.contentTypes.create({
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [
        title,
        {
          apiId: 'author',
          name: 'Author',
          type: 'Link',
          linkType: 'Entry',
          localized: false,
          required: false,
          position: 1,
          validations: { linkContentTypes: ['author'] },
        },
      ],
    });

    const clone = await cma.contentTypes.clone('post', { apiId: 'story', name: 'Story' });
    expect(clone).toMatchObject({ apiId: 'story', name: 'Story', version: 1, status: 'draft' });
    expect(
      (await request('POST', '/content-types/post/clone', { apiId: 'story', name: 'X' })).status,
    ).toBe(409);

    const deps = await cma.contentTypes.dependents('author');
    expect(deps.linkedFrom).toEqual([
      { contentType: 'post', field: 'author' },
      { contentType: 'story', field: 'author' },
    ]);
    const refused = await request('DELETE', '/content-types/author');
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: { message: string; details?: unknown } };
    expect(body.error.message).toContain('post.author');
    expect(JSON.stringify(body.error.details)).toContain('linkedFrom');

    expect(await cma.contentTypes.delete('story')).toEqual({ deleted: true });
    expect((await request('GET', '/content-types/story')).status).toBe(404);
    expect((await request('DELETE', '/content-types/story')).status).toBe(404);

    // Audited, as every mutating request is.
    const audit = await ctx.store.audit.list('s1', { environmentId: 'main', limit: 20 });
    expect(audit.map((a) => a.action)).toContain(
      'DELETE /spaces/:space/environments/:env/content-types/:apiId',
    );
  });

  it('starts a job for a type with entries when asked to purge them, and refuses a key without the scopes', async () => {
    const { cma, request } = setup();
    await cma.contentTypes.create({
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [title],
    });
    await cma.entries.create({ contentTypeApiId: 'note', fields: { title: { 'en-US': 'a' } } });
    expect((await request('DELETE', '/content-types/note')).status).toBe(409);

    const started = await request('DELETE', '/content-types/note?purge_entries=true');
    expect(started.status).toBe(202);
    const job = (await started.json()) as {
      deleted: boolean;
      job: { action: string; totalItems: number };
    };
    expect(job).toMatchObject({
      deleted: false,
      job: { action: 'content_type_delete', totalItems: 1 },
    });

    // A Delivery key can't delete a type at all.
    expect((await request('DELETE', '/content-types/note', undefined, 'cda')).status).toBe(403);
  });

  it('withholds dependents from a role restricted to other types', async () => {
    const { cma, request, roleKey } = setup();
    for (const apiId of ['page', 'note']) {
      await cma.contentTypes.create({ apiId, name: apiId, displayField: 'title', fields: [title] });
    }
    const pagesOnly = await roleKey(['preview:read', 'content:manage'], ['page']);
    expect(
      (await request('GET', '/content-types/note/dependents', undefined, pagesOnly)).status,
    ).toBe(403);
    expect(
      (await request('GET', '/content-types/page/dependents', undefined, pagesOnly)).status,
    ).toBe(200);
  });

  it('takes content:write, and a role on every type, to purge entries with the type', async () => {
    const { cma, request, roleKey } = setup();
    await cma.contentTypes.create({
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [title],
    });
    await cma.entries.create({ contentTypeApiId: 'note', fields: { title: { 'en-US': 'a' } } });

    const noWrite = await roleKey(['content:manage', 'content:publish', 'preview:read']);
    const purge = (token: string) =>
      request('DELETE', '/content-types/note?purge_entries=true', undefined, token);
    expect((await purge(noWrite)).status).toBe(403);
    const restricted = await roleKey(
      ['content:manage', 'content:write', 'content:publish', 'preview:read'],
      ['note'],
    );
    expect((await purge(restricted)).status).toBe(403);
    // Nothing was started by either.
    expect((await request('GET', '/bulk/jobs')).status).toBe(200);
    expect(((await (await request('GET', '/bulk/jobs')).json()) as unknown[]).length).toBe(0);
  });

  it('answers 409 when a create loses the race to its type’s delete', async () => {
    const { ctx, cma, request } = setup();
    await cma.contentTypes.create({
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [title],
    });
    // The type goes between the create's read and its commit.
    const guard = ctx.store.contentTypes.guard;
    ctx.store.contentTypes.guard = async (scope, apiId, expected) => {
      await ctx.store.contentTypes.delete(scope, apiId, 1);
      return guard(scope, apiId, expected);
    };
    const res = await request('POST', '/entries', {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'orphan' } },
    });
    ctx.store.contentTypes.guard = guard;
    expect(res.status).toBe(409);
    expect(
      (
        await ctx.store.entries.list(
          { spaceId: 's1', environmentId: 'main' },
          { contentTypeApiId: 'note' },
        )
      ).length,
    ).toBe(0);
  });
});
