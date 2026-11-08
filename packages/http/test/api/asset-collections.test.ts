import type { ApiConfig } from '@commerceworker/platform/config';
import type { FakeBlobStore } from '@commerceworker/test-kit';
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

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda' };
const M = '/spaces/s1/environments/main';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  return { app, ctx: wired.ctx, blob: wired.blob as FakeBlobStore };
}
type App = ReturnType<typeof makeApp>;

const send = (h: App, method: string, path: string, body?: unknown, headers = admin) =>
  h.app.request(`${M}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

async function upload(h: App, fileName: string) {
  const res = await send(h, 'POST', '/assets', { fileName, contentType: 'image/png' });
  expect(res.status).toBe(201);
  return (await json<{ asset: { id: string } }>(res)).asset;
}

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

describe('collections over HTTP', () => {
  it('creates, adds, reorders, lists, removes and deletes', async () => {
    const h = makeApp();
    const [a, b] = [await upload(h, 'a.png'), await upload(h, 'b.png')];
    const created = await send(h, 'POST', '/asset-collections', { name: 'Kit' });
    expect(created.status).toBe(201);
    const c = await json<{ id: string }>(created);
    expect(
      await json(
        await send(h, 'POST', `/asset-collections/${c.id}/assets`, {
          assetIds: [a.id, b.id, 'ghost'],
        }),
      ),
    ).toEqual({ added: 2, skipped: ['ghost'] });
    expect(
      (await send(h, 'PUT', `/asset-collections/${c.id}/order`, { assetIds: [b.id] })).status,
    ).toBe(204);
    const page = await json<{ items: { id: string; file: { url: string } }[] }>(
      await send(h, 'GET', `/asset-collections/${c.id}/assets`),
    );
    expect(page.items.map((x) => x.id)).toEqual([b.id, a.id]);
    // Reads hand out short-lived URLs, as the library does.
    expect(page.items[0]?.file.url).toContain('ttl=');
    expect(
      await json(
        await send(h, 'POST', `/asset-collections/${c.id}/assets/remove`, { assetIds: [a.id] }),
      ),
    ).toEqual({ removed: 1 });
    expect(await json(await send(h, 'GET', `/asset-collections/${c.id}`))).toMatchObject({
      itemCount: 1,
    });
    const list = await json<{ items: { name: string }[] }>(
      await send(h, 'GET', '/asset-collections'),
    );
    expect(list.items.map((x) => x.name)).toEqual(['Kit']);
    expect((await send(h, 'DELETE', `/asset-collections/${c.id}`)).status).toBe(204);
    expect((await send(h, 'GET', `/asset-collections/${c.id}`)).status).toBe(404);
  });

  it('needs content:write to change one and preview:read to read one', async () => {
    const h = makeApp();
    const c = await json<{ id: string }>(
      await send(h, 'POST', '/asset-collections', { name: 'K' }),
    );
    const reader = await keyWithScopes(h, 'Reader', ['preview:read']);
    expect((await send(h, 'GET', `/asset-collections/${c.id}`, undefined, reader)).status).toBe(
      200,
    );
    expect((await send(h, 'POST', '/asset-collections', { name: 'X' }, reader)).status).toBe(403);
    expect(
      (await send(h, 'PUT', `/asset-collections/${c.id}/order`, { assetIds: ['a'] }, reader))
        .status,
    ).toBe(403);
    const writer = await keyWithScopes(h, 'Writer', ['content:write', 'preview:read']);
    expect((await send(h, 'POST', '/asset-collections', { name: 'Y' }, writer)).status).toBe(201);
    // An over-long id list is refused before it reaches the store.
    const ids = Array.from({ length: 501 }, (_, i) => `id${i}`);
    expect(
      (await send(h, 'POST', `/asset-collections/${c.id}/assets`, { assetIds: ids })).status,
    ).toBe(422);
  });

  it('delivers a collection’s published members to a Delivery key', async () => {
    const h = makeApp();
    const [a, b] = [await upload(h, 'a.png'), await upload(h, 'b.png')];
    await send(h, 'POST', `/assets/${a.id}/published`);
    const c = await json<{ id: string }>(
      await send(h, 'POST', '/asset-collections', { name: 'Pub' }),
    );
    await send(h, 'POST', `/asset-collections/${c.id}/assets`, { assetIds: [b.id, a.id] });
    const res = await h.app.request(`/delivery/s1/main/collections/${c.id}`, { headers: cda });
    expect(res.status).toBe(200);
    const body = await json<{ name: string; items: { id: string }[] }>(res);
    expect(body.name).toBe('Pub');
    expect(body.items.map((x) => x.id)).toEqual([a.id]);
    expect(
      (await h.app.request(`/delivery/s1/main/collections/ghost`, { headers: cda })).status,
    ).toBe(404);
  });
});

describe('share links over HTTP', () => {
  it('need content:publish to create, list and revoke', async () => {
    const h = makeApp();
    const a = await upload(h, 'a.png');
    await send(h, 'POST', `/assets/${a.id}/published`);
    const link = {
      targetType: 'asset',
      targetId: a.id,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      password: 'long enough',
    };
    const writer = await keyWithScopes(h, 'Writer', ['content:write', 'preview:read']);
    expect((await send(h, 'POST', '/share-links', link, writer)).status).toBe(403);
    expect((await send(h, 'GET', '/share-links', undefined, writer)).status).toBe(403);
    const publisher = await keyWithScopes(h, 'Publisher', ['content:publish']);
    const created = await send(h, 'POST', '/share-links', link, publisher);
    expect(created.status).toBe(201);
    const body = await json<{ id: string; hasPassword: boolean }>(created);
    expect(body.hasPassword).toBe(true);
    expect(JSON.stringify(body)).not.toContain('long enough');
    expect((await send(h, 'DELETE', `/share-links/${body.id}`, undefined, writer)).status).toBe(
      403,
    );
    const revoked = await json<{ revokedAt?: string }>(
      await send(h, 'DELETE', `/share-links/${body.id}`, undefined, publisher),
    );
    expect(revoked.revokedAt).toBeDefined();
    const active = await json<{ items: unknown[] }>(
      await send(h, 'GET', '/share-links', undefined, publisher),
    );
    expect(active.items).toEqual([]);
  });

  it('refuses a draft asset (409) and a bad expiry (422)', async () => {
    const h = makeApp();
    const a = await upload(h, 'a.png');
    const body = {
      targetType: 'asset',
      targetId: a.id,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    expect((await send(h, 'POST', '/share-links', body)).status).toBe(409);
    await send(h, 'POST', `/assets/${a.id}/published`);
    expect((await send(h, 'POST', '/share-links', { ...body, expiresAt: 'tomorrow' })).status).toBe(
      422,
    );
  });
});

describe('multipart uploads and zips over HTTP', () => {
  it('starts, signs, completes and aborts a multipart upload with content:write', async () => {
    const h = makeApp();
    const size = 8 * 1024 * 1024 + 10;
    const started = await send(h, 'POST', '/assets/uploads', {
      fileName: 'film.mov',
      contentType: 'video/quicktime',
      size,
    });
    expect(started.status).toBe(201);
    const { asset, upload } = await json<{
      asset: { id: string };
      upload: { uploadId: string; partCount: number };
    }>(started);
    expect(upload.partCount).toBe(2);
    const base = `/assets/${asset.id}/uploads/${upload.uploadId}`;
    const signed = await json<{ parts: { partNumber: number; length: number }[] }>(
      await send(h, 'POST', `${base}/parts`, { partNumbers: [1, 2] }),
    );
    expect(signed.parts.map((p) => p.length)).toEqual([8 * 1024 * 1024, 10]);
    const key = `s1/main/${asset.id}/film.mov`;
    const parts = [];
    for (const p of signed.parts) {
      parts.push(
        await h.blob.multipart.uploadPart(
          key,
          upload.uploadId,
          p.partNumber,
          new Uint8Array(p.length),
        ),
      );
    }
    const done = await send(h, 'POST', `${base}/complete`, { parts });
    expect(done.status).toBe(200);
    expect((await h.blob.head(key))?.size).toBe(size);

    const reader = await keyWithScopes(h, 'Reader', ['preview:read']);
    expect(
      (
        await send(
          h,
          'POST',
          '/assets/uploads',
          { fileName: 'a', contentType: 'a/b', size: 1 },
          reader,
        )
      ).status,
    ).toBe(403);
    const again = await json<{ asset: { id: string }; upload: { uploadId: string } }>(
      await send(h, 'POST', '/assets/uploads', { fileName: 'b.bin', contentType: 'a/b', size: 5 }),
    );
    expect(
      (await send(h, 'DELETE', `/assets/${again.asset.id}/uploads/${again.upload.uploadId}`))
        .status,
    ).toBe(204);
    expect((await send(h, 'GET', `/assets/${again.asset.id}`)).status).toBe(404);
  });

  it('replaces a file in parts: completing commits the version, needs content:write, and one whose version was taken is 409', async () => {
    const h = makeApp();
    const asset = await upload(h, 'hero.png');
    await h.blob.put(`s1/main/${asset.id}/hero.png`, 'v1', 'image/png');
    const size = 8 * 1024 * 1024 + 10;
    const reader = await keyWithScopes(h, 'Reader', ['preview:read']);
    const body = { fileName: 'hero-large.png', contentType: 'image/png', size };
    expect((await send(h, 'POST', `/assets/${asset.id}/file/uploads`, body, reader)).status).toBe(
      403,
    );
    const res = await send(h, 'POST', `/assets/${asset.id}/file/uploads`, body);
    expect(res.status).toBe(201);
    const started = await json<{
      version: number;
      upload: { uploadId: string; partCount: number };
    }>(res);
    expect(started).toMatchObject({ version: 2, upload: { partCount: 2 } });
    const base = `/assets/${asset.id}/uploads/${started.upload.uploadId}`;
    const signed = await json<{ parts: { partNumber: number; length: number }[] }>(
      await send(h, 'POST', `${base}/parts`, { partNumbers: [1, 2] }),
    );
    // The upload's own key for version 2.
    const key = h.blob.uploadsInProgress.get(started.upload.uploadId)?.key ?? '';
    expect(key).toMatch(new RegExp(`^s1/main/${asset.id}/v2/file-[^/]+/hero-large\\.png$`));
    const parts = [];
    for (const p of signed.parts) {
      parts.push(
        await h.blob.multipart.uploadPart(
          key,
          started.upload.uploadId,
          p.partNumber,
          new Uint8Array(p.length),
        ),
      );
    }
    const done = await send(h, 'POST', `${base}/complete`, { parts });
    expect(done.status).toBe(200);
    const committed = await json<Record<string, unknown>>(done);
    expect(committed).toMatchObject({ version: 2, file: { size } });
    // The new version is at the upload's key; the response never names it.
    expect(committed).not.toHaveProperty('r2Key');
    const scope = { spaceId: 's1', environmentId: 'main' };
    expect((await h.ctx.store.assets.get(scope, asset.id))?.r2Key).toBe(key);
    const versions = await json<{ items: { version: number; createdBy?: string }[] }>(
      await send(h, 'GET', `/assets/${asset.id}/versions`),
    );
    expect(versions.items.map((v) => v.version)).toEqual([2, 1]);

    // A replace in parts started from v1 completes after v2 was committed: 409, nothing changes.
    await send(h, 'POST', `/assets/${asset.id}/versions/1/restore`);
    const stale = await json<{ upload: { uploadId: string } }>(
      await send(h, 'POST', `/assets/${asset.id}/file/uploads`, body),
    );
    await send(h, 'POST', `/assets/${asset.id}/versions/2/restore`);
    const late = await send(
      h,
      'POST',
      `/assets/${asset.id}/uploads/${stale.upload.uploadId}/complete`,
      {
        parts: [
          { partNumber: 1, etag: 'e' },
          { partNumber: 2, etag: 'e' },
        ],
      },
    );
    expect(late.status).toBe(409);
  });

  it('asks for a zip with preview:read, refusing a key with content grants (as asset reads do)', async () => {
    const h = makeApp();
    const a = await upload(h, 'a.png');
    const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
    // A role key carries content grants: it reads no assets, so no zip of them either.
    const granted = await keyWithScopes(h, 'Reader', ['preview:read']);
    expect((await send(h, 'POST', '/asset-zips', { assetIds: [a.id] }, granted)).status).toBe(403);
    const reader = cpa;
    const res = await send(h, 'POST', '/asset-zips', { assetIds: [a.id], name: 'Pick' }, reader);
    expect(res.status).toBe(202);
    const job = await json<{ id: string; status: string; fileName: string }>(res);
    expect(job).toMatchObject({ status: 'pending', fileName: 'Pick.zip' });
    expect(
      await json(await send(h, 'GET', `/asset-zips/${job.id}`, undefined, reader)),
    ).toMatchObject({
      id: job.id,
    });
    expect(
      (await send(h, 'POST', '/asset-zips', { assetIds: [a.id], collectionId: 'c' })).status,
    ).toBe(422);
    const items = await json<{ items: unknown[] }>(await send(h, 'GET', '/asset-zips'));
    expect(items.items).toHaveLength(1);
  });
});
