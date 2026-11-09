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

/**
 * Regression for the cross-space key-minting escalation: a request-body
 * `spaceId` must never override the authorized `:space` route param when minting
 * an API key. Previously the body was spread over the route param, so any CMA
 * key (whose default grant includes space:admin) could mint a full key bound to
 * another space.
 */
describe('api-key minting cannot be rebound to another space', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
    // A second space to attempt to escalate into.
    await app.request('/spaces', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ spaceId: 's2', name: 'Second', defaultLocale: 'en-US' }),
    });
  });

  it('ignores a body spaceId and binds the key to the route space', async () => {
    // A routine CMA key for s1 (its default grant includes space:admin).
    const mint = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', name: 's1 writer' }),
    });
    expect(mint.status).toBe(201);
    const s1Token = ((await mint.json()) as { token: string }).token;
    const s1Auth = { Authorization: `Bearer ${s1Token}`, 'Content-Type': 'application/json' };

    // Attempt the escalation: mint against s1 but ask for s2 in the body.
    const attack = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: s1Auth,
      body: JSON.stringify({ kind: 'cma', spaceId: 's2' }),
    });
    expect(attack.status).toBe(201);
    const escalatedToken = ((await attack.json()) as { token: string }).token;
    const escalatedAuth = { Authorization: `Bearer ${escalatedToken}` };

    // The minted key must be bound to s1, NOT s2: it is authorized for s1...
    const onS1 = await app.request('/spaces/s1/api-keys', { headers: escalatedAuth });
    expect(onS1.status).toBe(200);
    // ...and rejected on s2.
    const onS2 = await app.request('/spaces/s2/api-keys', { headers: escalatedAuth });
    expect(onS2.status).toBe(403);
  });

  it('rejects an unknown api-key kind', async () => {
    const res = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'root' }),
    });
    expect(res.status).toBe(422);
  });
});

describe('deleting an environment stays within the caller’s space and role', () => {
  let app: ReturnType<typeof createApp>;
  const del = (space: string, env: string, auth: string) =>
    app.request(`/spaces/${space}/environments/${env}?confirm=${env}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${auth}` },
    });
  const mint = async (space: string, body: Record<string, unknown>) =>
    (
      (await (
        await app.request(`/spaces/${space}/api-keys`, {
          method: 'POST',
          headers: admin,
          body: JSON.stringify(body),
        })
      ).json()) as { token: string }
    ).token;

  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
    await app.request('/spaces', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ spaceId: 's2', name: 'Second', defaultLocale: 'en-US' }),
    });
    for (const space of ['s1', 's2']) {
      await app.request(`/spaces/${space}/environments`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ id: 'staging' }),
      });
    }
  });

  it('refuses a key for another space', async () => {
    const s1Writer = await mint('s1', { kind: 'cma' });
    expect((await del('s2', 'staging', s1Writer)).status).toBe(403);
  });

  it('refuses read-only keys and roles without space:admin', async () => {
    expect((await del('s1', 'staging', 'cda')).status).toBe(403);
    expect((await del('s1', 'staging', 'cpa')).status).toBe(403);
    // A writer's role: content scopes, no space:admin.
    const role = (await (
      await app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          name: 'Writer',
          scopes: ['content:write', 'content:publish', 'preview:read'],
        }),
      })
    ).json()) as { id: string };
    expect(role.id).toBeTruthy();
    const editorKey = await mint('s1', { kind: 'cma', roleId: role.id });
    expect((await del('s1', 'staging', editorKey)).status).toBe(403);
  });

  it('refuses even a key holding space:admin: it takes a person or the admin token', async () => {
    const s1Writer = await mint('s1', { kind: 'cma' });
    expect((await del('s1', 'staging', s1Writer)).status).toBe(403);
    expect((await del('s1', 'staging', 'admin')).status).toBe(200);
    const s2 = (await (
      await app.request('/spaces/s2/environments', { headers: admin })
    ).json()) as {
      items: { id: string }[];
    };
    expect(s2.items.map((e) => e.id)).toContain('staging');
  });
});

describe('entry counts stay within the caller’s space and scope', () => {
  let app: ReturnType<typeof createApp>;
  const counts = (space: string, auth: string) =>
    app.request(`/spaces/${space}/environments/main/content-types/entry-counts`, {
      headers: { Authorization: `Bearer ${auth}` },
    });
  const mint = async (space: string, body: Record<string, unknown>) =>
    (
      (await (
        await app.request(`/spaces/${space}/api-keys`, {
          method: 'POST',
          headers: admin,
          body: JSON.stringify(body),
        })
      ).json()) as { token: string }
    ).token;

  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
    await app.request('/spaces', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ spaceId: 's2', name: 'Second', defaultLocale: 'en-US' }),
    });
  });

  it('refuses a preview key for another space, and counts for its own', async () => {
    const spaceB = await mint('s2', { kind: 'cpa' });
    expect((await counts('s1', spaceB)).status).toBe(403);
    expect((await counts('s2', spaceB)).status).toBe(200);
  });

  it('refuses a delivery key: it has no preview:read', async () => {
    expect((await counts('s1', 'cda')).status).toBe(403);
    const minted = await mint('s1', { kind: 'cda' });
    expect((await counts('s1', minted)).status).toBe(403);
  });

  it('answers a preview key for its own space', async () => {
    expect((await counts('s1', 'cpa')).status).toBe(200);
  });
});
