import type { ApiConfig } from '@commerceworker/platform/config';
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
const SCOPES = ['content:write', 'content:publish', 'preview:read'];

describe('finer content actions over HTTP: delete and unpublish', () => {
  let app: ReturnType<typeof createApp>;

  const keyFor = async (grant: Record<string, unknown>) => {
    const role = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: `Role ${Math.random()}`,
        scopes: SCOPES,
        contentGrants: [{ contentTypeApiId: 'post', ...grant }],
      }),
    });
    expect(role.status).toBe(201);
    const { id } = (await role.json()) as { id: string };
    const key = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId: id }),
    });
    const { token } = (await key.json()) as { token: string };
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };

  const entry = async (publish: boolean) => {
    const res = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ contentTypeApiId: 'post', fields: { title: { 'en-US': 'Post' } } }),
    });
    const { entry: e } = (await res.json()) as { entry: { id: string } };
    if (publish) {
      await app.request(`${M}/entries/${e.id}/published`, { method: 'POST', headers: admin });
    }
    return e.id;
  };

  const trash = (id: string, as: Record<string, string>) =>
    app.request(`${M}/entries/${id}`, { method: 'DELETE', headers: as });
  const purge = (id: string, as: Record<string, string>) =>
    app.request(`${M}/entries/${id}/permanent`, { method: 'DELETE', headers: as });
  const unpublish = (id: string, as: Record<string, string>) =>
    app.request(`${M}/entries/${id}/published`, { method: 'DELETE', headers: as });

  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai);
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        apiId: 'post',
        name: 'Post',
        displayField: 'title',
        fields: [
          {
            apiId: 'title',
            name: 'Title',
            type: 'Symbol',
            localized: false,
            required: false,
            position: 0,
          },
        ],
      }),
    });
    await app.request(`${M}/content-types/post/published`, { method: 'POST', headers: admin });
  });

  it('stores deniedActions on a role, and refuses delete or unpublish listed as actions', async () => {
    const created = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'No deletes',
        scopes: SCOPES,
        contentGrants: [
          { contentTypeApiId: '*', actions: ['read', 'write'], deniedActions: ['delete'] },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const read = (await (
      await app.request(`/spaces/s1/roles/${id}`, { headers: admin })
    ).json()) as { contentGrants: { deniedActions?: string[] }[] };
    expect(read.contentGrants[0]?.deniedActions).toEqual(['delete']);

    for (const grant of [
      { contentTypeApiId: '*', actions: ['read', 'delete'] },
      { contentTypeApiId: '*', actions: ['read'], deniedActions: ['write'] },
    ]) {
      const bad = await app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ name: 'Bad', scopes: SCOPES, contentGrants: [grant] }),
      });
      expect(bad.status).toBe(422);
    }
  });

  it('a grant that withholds nothing trashes, purges and unpublishes as before', async () => {
    const legacy = await keyFor({ actions: ['read', 'write', 'publish'] });
    const live = await entry(true);
    expect((await unpublish(live, legacy)).status).toBe(200);
    expect((await trash(live, legacy)).status).toBe(200);
    expect((await purge(live, legacy)).status).toBe(204);
    // Without publish it never purged or unpublished, and still doesn't.
    const writer = await keyFor({ actions: ['read', 'write'] });
    const other = await entry(true);
    expect((await unpublish(other, writer)).status).toBe(403);
    expect((await trash(other, writer)).status).toBe(200);
    expect((await purge(other, writer)).status).toBe(403);
  });

  it('a role that writes but withholds delete can neither trash nor purge', async () => {
    const noDelete = await keyFor({
      actions: ['read', 'write', 'publish'],
      deniedActions: ['delete'],
    });
    const id = await entry(false);
    const refused = await trash(id, noDelete);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('content:delete:post');
    // Still writes.
    const saved = await app.request(`${M}/entries/${id}`, {
      method: 'PUT',
      headers: noDelete,
      body: JSON.stringify({ fields: { title: { 'en-US': 'Edited' } } }),
    });
    expect(saved.status).toBe(200);
    expect((await trash(id, admin)).status).toBe(200);
    expect((await purge(id, noDelete)).status).toBe(403);
  });

  it('a role that publishes but withholds unpublish can’t take an entry down by any route', async () => {
    const keepsLive = await keyFor({
      actions: ['read', 'write', 'publish'],
      deniedActions: ['unpublish'],
    });
    const live = await entry(true);
    expect((await unpublish(live, keepsLive)).status).toBe(403);
    const bulk = await app.request(`${M}/bulk/entries/unpublish`, {
      method: 'POST',
      headers: keepsLive,
      body: JSON.stringify({ ids: [live] }),
    });
    expect(bulk.status).toBe(403);
    // Trashing a live entry would unpublish it.
    expect((await trash(live, keepsLive)).status).toBe(403);

    const scheduled = await app.request(`${M}/scheduled-actions`, {
      method: 'POST',
      headers: keepsLive,
      body: JSON.stringify({
        action: 'unpublish',
        entityType: 'Entry',
        entityId: live,
        scheduledFor: '2099-01-01T00:00:00.000Z',
      }),
    });
    expect(scheduled.status).toBe(403);
    // Scheduling a publish is still its to do.
    const later = await app.request(`${M}/scheduled-actions`, {
      method: 'POST',
      headers: keepsLive,
      body: JSON.stringify({
        action: 'publish',
        entityType: 'Entry',
        entityId: live,
        scheduledFor: '2099-01-01T00:00:00.000Z',
      }),
    });
    expect(later.status).toBe(201);

    const release = (await (
      await app.request(`${M}/releases`, {
        method: 'POST',
        headers: keepsLive,
        body: JSON.stringify({ title: 'Takedown' }),
      })
    ).json()) as { id: string };
    const addItem = (as: Record<string, string>) =>
      app.request(`${M}/releases/${release.id}/items`, {
        method: 'POST',
        headers: as,
        body: JSON.stringify({ entityId: live, action: 'unpublish' }),
      });
    // Scheduled for later, the release would ship with no one behind it: the item is refused now.
    const scheduledRelease = await app.request(`${M}/scheduled-actions`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        action: 'publish',
        entityType: 'release',
        entityId: release.id,
        scheduledFor: '2099-01-01T00:00:00.000Z',
      }),
    });
    expect(scheduledRelease.status).toBe(201);
    expect(((await scheduledRelease.json()) as { entityType: string }).entityType).toBe('Release');
    const added = await addItem(keepsLive);
    expect(added.status).toBe(403);
    expect(await added.text()).toContain('content:unpublish:post');
    // Put there by someone who may, it still can't ship it by hand.
    expect((await addItem(admin)).status).toBe(200);
    const shipped = await app.request(`${M}/releases/${release.id}/published`, {
      method: 'POST',
      headers: keepsLive,
    });
    expect(shipped.status).toBe(403);

    // Still live after every attempt; a draft it can still trash, and publishing still works.
    const delivered = await app.request(`${M}/entries/${live}`, { headers: admin });
    expect(
      ((await delivered.json()) as { entry: { publishedVersion: number | null } }).entry
        .publishedVersion,
    ).not.toBeNull();
    const draft = await entry(false);
    expect(
      (await app.request(`${M}/entries/${draft}/published`, { method: 'POST', headers: keepsLive }))
        .status,
    ).toBe(200);
    expect((await trash(await entry(false), keepsLive)).status).toBe(200);
  });
});
