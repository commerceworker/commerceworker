import {
  type AppContext,
  addToAssetCollection,
  archiveAsset,
  completeMultipartAssetUpload,
  createAsset,
  createAssetCollection,
  createAssetShareLink,
  createEnvironment,
  createSpace,
  deleteAsset,
  listAssetCollectionItems,
  publishAsset,
  requestAssetZip,
  revokeAssetShareLink,
  sharedAssetFile,
  startMultipartAssetFileReplacement,
  startMultipartAssetUpload,
} from '@commerceworker/application';
import { TransactionConflictError } from '@commerceworker/ports';
import { FakeBlobStore, FakePasswordHasher, FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Collections, share links, zip jobs and multipart uploads on D1 (0016_asset_collections): id lists
 * past the 100-parameter cap in one JSON parameter, membership kept to the scope, the guards that
 * refuse a lost race at commit, and every table cleared with its environment. Each test makes its
 * own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();

async function harness() {
  const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
  const ctx: AppContext = {
    store,
    clock,
    ids: { newId: uid },
    passwords: new FakePasswordHasher(),
  };
  const spaceId = `col-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Collections', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
  const blob = new FakeBlobStore();
  const upload = async (fileName: string, s = scope) =>
    (await createAsset(ctx, blob, s, { fileName, contentType: 'image/png' })).asset;
  return { ctx, clock, scope, spaceId, blob, upload };
}

const names = async (
  ctx: AppContext,
  scope: { spaceId: string; environmentId: string },
  id: string,
) =>
  (
    await listAssetCollectionItems(ctx, scope, id, { limit: 1000, filters: { status: 'all' } })
  ).items.map((a) => a.file.fileName);

describe('collections on D1', () => {
  it('adds, reorders and removes 150 assets, each a single statement', async () => {
    const { ctx, scope, upload } = await harness();
    const assets = [];
    for (let i = 0; i < 150; i++) assets.push(await upload(`f${String(i).padStart(3, '0')}.png`));
    const c = await createAssetCollection(ctx, scope, { name: 'Big' });
    const reversed = [...assets].reverse().map((a) => a.id);
    expect(await addToAssetCollection(ctx, scope, c.id, reversed)).toEqual({
      added: 150,
      skipped: [],
    });
    const listed = await names(ctx, scope, c.id);
    expect(listed[0]).toBe('f149.png');
    expect(listed.at(-1)).toBe('f000.png');
    // Put 120 named first, in file order; the other 30 follow as they were.
    const first = assets.slice(0, 120).map((a) => a.id);
    await store.assetCollections.reorder(scope, c.id, first);
    const after = await names(ctx, scope, c.id);
    expect(after.slice(0, 3)).toEqual(['f000.png', 'f001.png', 'f002.png']);
    expect(after[120]).toBe('f149.png');
    expect(after).toHaveLength(150);
    await store.assetCollections.removeItems(scope, c.id, first);
    expect(await names(ctx, scope, c.id)).toHaveLength(30);
    expect((await store.assetCollections.get(scope, c.id))?.itemCount).toBe(30);
  });

  it('pages in order with a keyset cursor, and lists published members only for Delivery', async () => {
    const { ctx, scope, upload } = await harness();
    const [a, b, c] = [await upload('a.png'), await upload('b.png'), await upload('c.png')];
    await publishAsset(ctx, scope, c.id);
    await publishAsset(ctx, scope, a.id);
    const col = await createAssetCollection(ctx, scope, { name: 'P' });
    await addToAssetCollection(ctx, scope, col.id, [c.id, b.id, a.id]);
    const page = await store.assetCollections.listItems(scope, col.id, { limit: 2 });
    expect(page.items.map((x) => x.id)).toEqual([c.id, b.id]);
    const rest = await store.assetCollections.listItems(scope, col.id, {
      limit: 2,
      cursor: page.nextCursor ?? '',
    });
    expect(rest.items.map((x) => x.id)).toEqual([a.id]);
    const published = await store.assetCollections.listPublishedItems(scope, col.id, {});
    expect(published.items.map((p) => p.assetId)).toEqual([c.id, a.id]);
  });

  it('never makes another scope’s asset a member, nor reads a collection across scopes', async () => {
    const { ctx, scope, spaceId, upload } = await harness();
    await createEnvironment(ctx, spaceId, 'staging');
    const staging = { spaceId, environmentId: 'staging' };
    const theirs = await upload('theirs.png', staging);
    const mine = await upload('mine.png');
    const c = await createAssetCollection(ctx, scope, { name: 'Mine' });
    // Straight to the store, past the use-case's own check: the INSERT … SELECT filters it.
    await store.assetCollections.addItems(scope, c.id, [mine.id, theirs.id], new Date(), 1000);
    expect(await store.assetCollections.listItemIds(scope, c.id)).toEqual([mine.id]);
    expect(await store.assetCollections.get(staging, c.id)).toBeNull();
    expect(await store.assetCollections.hasItem(staging, c.id, mine.id)).toBe(false);
  });

  it('refuses at commit an add into a deleted collection, or past the cap', async () => {
    const { ctx, scope, upload } = await harness();
    const [a, b, c] = [await upload('a.png'), await upload('b.png'), await upload('c.png')];
    const col = await createAssetCollection(ctx, scope, { name: 'Cap' });
    await expect(
      store.withTransaction((tx) =>
        tx.assetCollections.addItems(scope, col.id, [a.id, b.id, c.id], new Date(), 2),
      ),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(await store.assetCollections.listItemIds(scope, col.id)).toEqual([]);
    await store.assetCollections.delete(scope, col.id);
    await expect(
      store.withTransaction((tx) =>
        tx.assetCollections.addItems(scope, col.id, [a.id], new Date(), 10),
      ),
    ).rejects.toBeInstanceOf(TransactionConflictError);
  });

  it('counts only members whose asset exists toward the cap, and refuses a save or reorder of a deleted one', async () => {
    const { ctx, scope, upload } = await harness();
    const [a, b] = [await upload('a.png'), await upload('b.png')];
    const c = await createAssetCollection(ctx, scope, { name: 'Orphans' });
    // An import's members whose assets never arrived: invisible, and not counted.
    await store.assetCollections.restore(scope, c, [a.id, uid(), uid()]);
    await store.withTransaction((tx) =>
      tx.assetCollections.addItems(scope, c.id, [b.id], new Date(), 2),
    );
    expect(await store.assetCollections.get(scope, c.id)).toMatchObject({ itemCount: 2 });
    await store.assetCollections.delete(scope, c.id);
    await expect(
      store.withTransaction((tx) => tx.assetCollections.save(scope, { ...c, name: 'X' })),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    await expect(
      store.withTransaction((tx) => tx.assetCollections.reorder(scope, c.id, [a.id])),
    ).rejects.toBeInstanceOf(TransactionConflictError);
  });

  it('drops a deleted asset from every collection in the delete’s own batch', async () => {
    const { ctx, scope, upload } = await harness();
    const a = await upload('a.png');
    const x = await createAssetCollection(ctx, scope, { name: 'X' });
    const y = await createAssetCollection(ctx, scope, { name: 'Y' });
    await addToAssetCollection(ctx, scope, x.id, [a.id]);
    await addToAssetCollection(ctx, scope, y.id, [a.id]);
    expect((await store.assetCollections.collectionsOf(scope, a.id, 10)).sort()).toEqual(
      [x.id, y.id].sort(),
    );
    await archiveAsset(ctx, scope, a.id);
    await deleteAsset(ctx, scope, a.id);
    expect(await store.assetCollections.collectionsOf(scope, a.id, 10)).toEqual([]);
  });

  it('restores an import’s members whatever exists, counting only those whose asset does', async () => {
    const { ctx, scope, upload } = await harness();
    const a = await upload('a.png');
    const c = {
      id: uid(),
      name: 'Imported',
      itemCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const ghosts = Array.from({ length: 120 }, () => uid());
    await store.assetCollections.restore(scope, c, [a.id, ...ghosts]);
    // Again (a retried import): nothing doubles.
    await store.assetCollections.restore(scope, c, [a.id]);
    expect((await store.assetCollections.get(scope, c.id))?.itemCount).toBe(1);
    expect(await names(ctx, scope, c.id)).toEqual(['a.png']);
  });
});

describe('share links, zip jobs and uploads on D1', () => {
  it('creates a link only while its target exists, and revokes it once', async () => {
    const { ctx, scope, upload } = await harness();
    const a = await upload('a.png');
    await publishAsset(ctx, scope, a.id);
    const link = await createAssetShareLink(ctx, scope, {
      targetType: 'asset',
      targetId: a.id,
      expiresAt: '2026-01-02T00:00:00.000Z',
      password: 'long enough',
    });
    const stored = await store.assetShareLinks.get(scope, link.id);
    expect(stored).toMatchObject({
      targetId: a.id,
      allowDownload: false,
      passwordHash: expect.any(String),
    });
    await revokeAssetShareLink(ctx, scope, link.id);
    await expect(
      store.withTransaction((tx) => tx.assetShareLinks.revoke(scope, link.id, new Date())),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    await expect(
      store.withTransaction((tx) =>
        tx.assetShareLinks.create(scope, { ...stored!, id: uid(), targetId: uid() }),
      ),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(
      await store.assetShareLinks.list(scope, { now: new Date('2026-01-01T00:00:00.000Z') }),
    ).toEqual([]);
    expect(
      await store.assetShareLinks.list(scope, { now: new Date(), includeInactive: true }),
    ).toHaveLength(1);
    expect(
      await sharedAssetFile(store, scope, { targetType: 'asset', targetId: a.id }, a.id),
    ).not.toBeNull();
  });

  it('finds expired zips and stale uploads across scopes', async () => {
    const { ctx, clock, scope, blob, upload } = await harness();
    const a = await upload('a.png');
    const job = await requestAssetZip(ctx, scope, { assetIds: [a.id] });
    await store.assetZips.update(scope, job.id, { status: 'running', partsDone: 2, partCount: 3 });
    expect(await store.assetZips.get(scope, job.id)).toMatchObject({
      status: 'running',
      partsDone: 2,
    });
    const later = new Date(Date.parse(job.expiresAt) + 1);
    expect(await store.assetZips.listExpired(later, 1000)).toContainEqual({ scope, id: job.id });
    expect(await store.assetZips.listExpired(new Date(job.createdAt), 1000)).not.toContainEqual({
      scope,
      id: job.id,
    });
    const blobWithMultipart = blob;
    const started = await startMultipartAssetUpload(ctx, blobWithMultipart, scope, {
      fileName: 'big.bin',
      contentType: 'application/octet-stream',
      size: 10,
    });
    const stale = await store.assetUploads.listStartedBefore(
      new Date(clock.now().getTime() + 1),
      1000,
    );
    expect(stale.map((s) => s.upload.uploadId)).toContain(started.upload.uploadId);
  });

  it('clears every new table with its environment', async () => {
    const { ctx, clock, spaceId, blob } = await harness();
    const env = `gone-${uid().slice(0, 8)}`;
    await createEnvironment(ctx, spaceId, env);
    const s = { spaceId, environmentId: env };
    const { asset } = await createAsset(ctx, blob, s, {
      fileName: 'a.png',
      contentType: 'image/png',
    });
    await publishAsset(ctx, s, asset.id);
    const c = await createAssetCollection(ctx, s, { name: 'C' });
    await addToAssetCollection(ctx, s, c.id, [asset.id]);
    await createAssetShareLink(ctx, s, {
      targetType: 'collection',
      targetId: c.id,
      expiresAt: '2026-01-05T00:00:00.000Z',
    });
    await requestAssetZip(ctx, s, { collectionId: c.id });
    await startMultipartAssetUpload(ctx, blob, s, {
      fileName: 'b.bin',
      contentType: 'application/octet-stream',
      size: 10,
    });
    await store.spaces.deleteEnvironment(spaceId, env, [], {
      id: uid(),
      spaceId,
      environmentId: env,
      at: clock.now().toISOString(),
      actor: 'test',
      action: 'environment.deleted',
      status: 200,
    });
    while ((await store.spaces.purgeEnvironmentStep(spaceId, env, 500, clock.now())) > 0) {}
    const count = async (table: string) =>
      (
        await testDb
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE space_id = ? AND environment_id = ?`)
          .bind(spaceId, env)
          .first<{ n: number }>()
      )?.n;
    for (const table of [
      'asset_collections',
      'asset_collection_items',
      'asset_share_links',
      'asset_zip_jobs',
      'asset_uploads',
    ]) {
      expect(await count(table)).toBe(0);
    }
  });
});

describe('replacing a file in parts on D1', () => {
  it('lists an asset’s uploads in its own scope, and forgets one in the commit unit', async () => {
    const { ctx, spaceId, scope, blob, upload } = await harness();
    const a = await upload('hero.png');
    await blob.put(`${spaceId}/main/${a.id}/hero.png`, 'v1', 'image/png');
    const staging = { spaceId, environmentId: `stg-${uid().slice(0, 8)}` };
    await createEnvironment(ctx, spaceId, staging.environmentId);
    const started = await startMultipartAssetFileReplacement(ctx, blob, scope, a.id, {
      fileName: 'big.png',
      contentType: 'image/png',
      size: 12,
    });
    expect((await store.assetUploads.listForAsset(scope, a.id)).map((u) => u.uploadId)).toEqual([
      started.upload.uploadId,
    ]);
    expect(await store.assetUploads.listForAsset(staging, a.id)).toEqual([]);
    const key = (await store.assetUploads.listForAsset(scope, a.id))[0]?.r2Key ?? '';
    expect(key).toMatch(new RegExp(`^${spaceId}/main/${a.id}/v2/file-[^/]+/big\\.png$`));
    const part = await blob.multipart.uploadPart(
      key,
      started.upload.uploadId,
      1,
      new Uint8Array(12),
    );
    const done = await completeMultipartAssetUpload(
      ctx,
      { blob },
      scope,
      a.id,
      started.upload.uploadId,
      [part],
      { by: 'ann' },
    );
    expect(done).toMatchObject({ version: 2, r2Key: key });
    expect(await store.assets.get(scope, a.id)).toMatchObject({ version: 2, r2Key: key });
    expect(await store.assetUploads.listForAsset(scope, a.id)).toEqual([]);
    expect((await store.assets.listVersions(scope, a.id)).map((v) => v.version)).toContain(1);
  });
});
