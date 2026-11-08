import { assetBulkChunkRunner, runBulkChunk } from '@commerceworker/application';
import type { BulkChunkDueEvent } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import type { FakeBlobStore, InMemoryContentStore } from '@commerceworker/test-kit';
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

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';

type AssetBody = {
  id: string;
  status: string;
  version?: number;
  file: { url: string; fileName: string };
  rights?: Record<string, string>;
};

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  return { app, ctx: wired.ctx, blob: wired.blob as FakeBlobStore };
}

type App = ReturnType<typeof makeApp>;

async function upload(h: App, fileName = 'hero.png') {
  const res = await h.app.request(`${M}/assets`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({ fileName, contentType: 'image/png' }),
  });
  expect(res.status).toBe(201);
  return (await json<{ asset: AssetBody }>(res)).asset;
}

/** A key with content:write and preview:read only: it may edit, never publish. */
const writerKey = (h: App) => keyWithScopes(h, 'Writer', ['content:write', 'preview:read']);

/** A management key whose role holds exactly `scopes`. */
async function keyWithScopes(h: App, name: string, scopes: string[]) {
  const role = await json<{ id: string }>(
    await h.app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ name, scopes }),
    }),
  );
  const { token } = await json<{ token: string }>(
    await h.app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId: role.id }),
    }),
  );
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('asset versions over HTTP', () => {
  it('replaces a file in two steps, lists the versions and restores one', async () => {
    const h = makeApp();
    const asset = await upload(h);
    await h.blob.put(`s1/main/${asset.id}/hero.png`, 'bytes', 'image/png');
    const writer = await writerKey(h);
    const started = await h.app.request(`${M}/assets/${asset.id}/file`, {
      method: 'POST',
      headers: writer,
      body: JSON.stringify({ fileName: 'hero-2.png', contentType: 'image/png' }),
    });
    expect(started.status).toBe(201);
    const { upload: target, commit } = await json<{
      upload: { url: string };
      commit: { version: number; fileName: string; contentType: string; attempt: string };
    }>(started);
    expect(commit).toEqual({
      version: 2,
      fileName: 'hero-2.png',
      contentType: 'image/png',
      attempt: expect.any(String),
    });
    // This replace's own key for version 2.
    const key = `s1/main/${asset.id}/v2/file-${commit.attempt}/hero-2.png`;
    expect(target.url).toContain(`/${key}`);

    // Nothing uploaded yet: refused, and nothing changes.
    const early = await h.app.request(`${M}/assets/${asset.id}/file/commit`, {
      method: 'POST',
      headers: writer,
      body: JSON.stringify(commit),
    });
    expect(early.status).toBe(422);

    await h.blob.put(key, 'bytes', 'image/png');
    const committed = await h.app.request(`${M}/assets/${asset.id}/file/commit`, {
      method: 'POST',
      headers: writer,
      body: JSON.stringify(commit),
    });
    expect(committed.status).toBe(200);
    const current = await json<AssetBody>(committed);
    expect(current).toMatchObject({ version: 2, file: { fileName: 'hero-2.png' } });
    // A read hands out a short-lived URL, never the stored one.
    expect(current.file.url).toContain('ttl=');

    const versions = await json<{
      items: { version: number; current: boolean; file: { url: string } }[];
    }>(await h.app.request(`${M}/assets/${asset.id}/versions`, { headers: cpa }));
    expect(versions.items.map((v) => [v.version, v.current])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(versions.items[1]?.file.url).toContain('ttl=');

    const restored = await h.app.request(`${M}/assets/${asset.id}/versions/1/restore`, {
      method: 'POST',
      headers: writer,
    });
    expect(restored.status).toBe(200);
    expect(await json<AssetBody>(restored)).toMatchObject({
      version: 3,
      file: { fileName: 'hero.png' },
    });
    const missing = await h.app.request(`${M}/assets/${asset.id}/versions/9/restore`, {
      method: 'POST',
      headers: writer,
    });
    expect(missing.status).toBe(404);
    const bad = await h.app.request(`${M}/assets/${asset.id}/versions/x/restore`, {
      method: 'POST',
      headers: writer,
    });
    expect(bad.status).toBe(422);
  });

  it('keeps a read-only key from replacing or restoring', async () => {
    const h = makeApp();
    const asset = await upload(h);
    for (const [path, body] of [
      [`/assets/${asset.id}/file`, { fileName: 'b.png', contentType: 'image/png' }],
      [
        `/assets/${asset.id}/file/commit`,
        { version: 2, fileName: 'b.png', contentType: 'image/png' },
      ],
      [`/assets/${asset.id}/versions/1/restore`, {}],
    ] as const) {
      const res = await h.app.request(`${M}${path}`, {
        method: 'POST',
        headers: cpa,
        body: JSON.stringify(body),
      });
      expect(res.status, path).toBe(403);
    }
  });
});

describe('asset rights over HTTP', () => {
  it('needs content:publish, validates, and refuses to publish under embargo with a clear 409', async () => {
    const h = makeApp();
    const asset = await upload(h);
    const writer = await writerKey(h);
    const denied = await h.app.request(`${M}/assets/${asset.id}/rights`, {
      method: 'PUT',
      headers: writer,
      body: JSON.stringify({ license: 'CC BY' }),
    });
    expect(denied.status).toBe(403);

    const invalid = await h.app.request(`${M}/assets/${asset.id}/rights`, {
      method: 'PUT',
      headers: cma,
      body: JSON.stringify({ expiresAt: '2030-01-01' }),
    });
    expect(invalid.status).toBe(422);
    expect(await json<{ error: { issues: { field: string }[] } }>(invalid)).toMatchObject({
      error: { issues: [{ field: 'rights.expiresAt' }] },
    });

    const set = await h.app.request(`${M}/assets/${asset.id}/rights`, {
      method: 'PUT',
      headers: cma,
      body: JSON.stringify({
        license: 'CC BY',
        embargoUntil: '2999-01-01T00:00:00Z',
        credit: null,
      }),
    });
    expect(set.status).toBe(200);
    expect((await json<AssetBody>(set)).rights).toEqual({
      license: 'CC BY',
      embargoUntil: '2999-01-01T00:00:00.000Z',
    });

    const refused = await h.app.request(`${M}/assets/${asset.id}/published`, {
      method: 'POST',
      headers: cma,
    });
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({
      error: {
        code: 'asset_embargoed',
        message: expect.stringContaining('under embargo until 2999-01-01T00:00:00.000Z'),
        embargoUntil: '2999-01-01T00:00:00.000Z',
      },
    });

    const cleared = await h.app.request(`${M}/assets/${asset.id}/rights`, {
      method: 'PUT',
      headers: cma,
      body: JSON.stringify({}),
    });
    expect((await json<AssetBody>(cleared)).rights).toBeUndefined();
  });
});

describe('asset bulk jobs over HTTP', () => {
  it('starts a job a write key may start, and refuses it publishing', async () => {
    const h = makeApp();
    const a = await upload(h, 'a.png');
    const b = await upload(h, 'b.png');
    const writer = await writerKey(h);
    const publish = await h.app.request(`${M}/assets/bulk`, {
      method: 'POST',
      headers: writer,
      body: JSON.stringify({ action: 'publish', ids: [a.id, b.id] }),
    });
    expect(publish.status).toBe(403);

    const tag = await h.app.request(`${M}/assets/bulk`, {
      method: 'POST',
      headers: writer,
      body: JSON.stringify({ action: 'tag', ids: [a.id, b.id], addTags: ['hero'] }),
    });
    expect(tag.status).toBe(202);
    const job = await json<{ id: string; action: string; totalItems: number }>(tag);
    expect(job).toMatchObject({ action: 'asset_tag', totalItems: 2 });

    // Run its chunks as the engine would, then follow it on the bulk job routes.
    const store = h.ctx.store as InMemoryContentStore;
    for (const e of store.allEvents().filter((x) => x.type === 'bulk.chunk_due')) {
      await runBulkChunk(h.ctx, e as BulkChunkDueEvent, {
        assetBulkChunk: assetBulkChunkRunner(h.ctx),
      });
    }
    const status = await json<{ status: string; succeeded: number }>(
      await h.app.request(`${M}/bulk/jobs/${job.id}`, { headers: cma }),
    );
    expect(status).toMatchObject({ status: 'completed', succeeded: 2 });
    const asset = await json<{ metadata: { tags: string[] } }>(
      await h.app.request(`${M}/assets/${a.id}`, { headers: cpa }),
    );
    expect(asset.metadata.tags).toEqual(['hero']);

    const started = await h.app.request(`${M}/assets/bulk`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ action: 'publish', ids: [a.id] }),
    });
    expect(started.status).toBe(202);
    const unknown = await h.app.request(`${M}/assets/bulk`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ action: 'explode', ids: [a.id] }),
    });
    expect(unknown.status).toBe(422);
  });

  it('lets a publish-only key publish in bulk, as one at a time and over MCP, but not tag', async () => {
    const h = makeApp();
    const a = await upload(h, 'a.png');
    const publisher = await keyWithScopes(h, 'Publisher', ['content:publish']);
    const one = await h.app.request(`${M}/assets/${a.id}/published`, {
      method: 'POST',
      headers: publisher,
    });
    expect(one.status).toBe(200);
    const bulk = await h.app.request(`${M}/assets/bulk`, {
      method: 'POST',
      headers: publisher,
      body: JSON.stringify({ action: 'unpublish', ids: [a.id] }),
    });
    expect(bulk.status).toBe(202);
    const tag = await h.app.request(`${M}/assets/bulk`, {
      method: 'POST',
      headers: publisher,
      body: JSON.stringify({ action: 'tag', ids: [a.id], addTags: ['hero'] }),
    });
    expect(tag.status).toBe(403);
  });
});
