import {
  ConflictError,
  type DomainEvent,
  NotFoundError,
  ValidationError,
} from '@commerceworker/domain';
import {
  FakeAssetIngestQueue,
  FakeBlobStore,
  FixedClock,
  InMemoryAssetGate,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  archiveAsset,
  assetFileKey,
  assetGateEntry,
  assetKeyVersion,
  assetObjectKey,
  cloneEnvironment,
  commitAssetFile,
  createAsset,
  createEnvironment,
  createSpace,
  deleteAsset,
  deleteAssetFiles,
  dispatchEvent,
  getAsset,
  getPublishedAsset,
  isAssetFileKey,
  listAssetVersions,
  parseAssetObjectKey,
  publishAsset,
  publishedSnapshot,
  replaceAssetFile,
  restoreAssetVersion,
  withReadUrl,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const ingest = new FakeAssetIngestQueue();
  const gate = new InMemoryAssetGate();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('a') };
  let dispatched = 0;
  /** Runs the outbox's new events through dispatch, as the engine does. */
  const drain = async () => {
    const events = store.allEvents();
    for (const e of events.slice(dispatched)) {
      await dispatchEvent(
        ctx,
        { sender: new RecordingWebhookSender(), blob, assetIngest: ingest, assetGate: gate },
        e as DomainEvent,
      );
    }
    dispatched = events.length;
  };
  const events = () => store.allEvents() as DomainEvent[];
  return { ctx, store, blob, ingest, gate, drain, events };
}

type Harness = ReturnType<typeof setup>;

async function upload(h: Harness, fileName = 'hero.png', s = scope) {
  const { asset } = await createAsset(h.ctx, h.blob, s, { fileName, contentType: 'image/png' });
  await h.blob.put(assetFileKey(s, asset), 'v1-bytes', 'image/png');
  return asset;
}

/** Replace, upload, commit: what a client does. */
async function replace(h: Harness, id: string, fileName: string, bytes = `${fileName}-bytes`) {
  const r = await replaceAssetFile(h.ctx, h.blob, scope, id, {
    fileName,
    contentType: 'image/png',
  });
  await h.blob.put(
    assetObjectKey(scope, id, r.commit.fileName, r.commit.version, r.commit.attempt),
    bytes,
    'image/png',
  );
  return commitAssetFile(h.ctx, h.blob, scope, id, r.commit, { by: 'ana@example.com' });
}

describe('asset file keys', () => {
  const id = '0190-asset';

  it('keeps the first file at four segments and puts each later version under v<n>/file/', () => {
    expect(assetObjectKey(scope, id, 'a.png')).toBe(`shop/main/${id}/a.png`);
    expect(assetObjectKey(scope, id, 'a.png', 1)).toBe(`shop/main/${id}/a.png`);
    expect(assetObjectKey(scope, id, '../../x/a.png', 3)).toBe(`shop/main/${id}/v3/file/a.png`);
    expect(assetKeyVersion(`shop/main/${id}/a.png`, id)).toBe(1);
    expect(assetKeyVersion(`shop/main/${id}/v3/file/a.png`, id)).toBe(3);
    // A replace attempt's own key: still version 3, still a file of this asset.
    expect(assetObjectKey(scope, id, 'a.png', 3, 'att-1')).toBe(
      `shop/main/${id}/v3/file-att-1/a.png`,
    );
    expect(assetKeyVersion(`shop/main/${id}/v3/file-att-1/a.png`, id)).toBe(3);
    expect(isAssetFileKey(`shop/main/${id}/v3/file-/a.png`)).toBe(false);
    expect(isAssetFileKey(`shop/main/${id}/v3/file-a.b/a.png`)).toBe(false);
  });

  it('never takes a derived file, a non-canonical version, or a shared prefix for a file', () => {
    // Extracted text sits beside the version's file, five segments deep: never served.
    expect(isAssetFileKey(`shop/main/${id}/v2/text.md`)).toBe(false);
    expect(parseAssetObjectKey(`shop/main/${id}/v2/text.md`)).toBeNull();
    // A dead letter's key has an asset key's four segments; writing one must not start an ingest.
    expect(parseAssetObjectKey('dlq/commerceworker-events-dlq/2026-11-04/m1.json')).toBeNull();
    expect(isAssetFileKey(`shop/main/${id}/v1/file/a.png`)).toBe(false);
    expect(isAssetFileKey(`shop/main/${id}/v02/file/a.png`)).toBe(false);
    expect(isAssetFileKey(`shop/main/${id}/v2/other/a.png`)).toBe(false);
    expect(isAssetFileKey(`shop/main/${id}/v2/file/..`)).toBe(false);
    expect(isAssetFileKey(`versions/main/${id}/v2/file/a.png`)).toBe(false);
    expect(parseAssetObjectKey(`shop/main/${id}/v2/file/a.png`)).toEqual({
      scope,
      assetId: id,
    });
  });

  it('ignores a forged key naming another asset, a derived file, or a version not yet committed', () => {
    const asset = { id, version: 2, file: { fileName: 'a.png' } };
    const own = `shop/main/${id}/v2/file/a.png`;
    expect(assetFileKey(scope, { ...asset, r2Key: 'shop/main/other-asset/v2/file/a.png' })).toBe(
      own,
    );
    expect(assetFileKey(scope, { ...asset, r2Key: `shop/main/${id}/v2/text.md` })).toBe(own);
    // An upload for v3 that nobody committed is not this asset's file, whatever a snapshot says.
    expect(assetFileKey(scope, { ...asset, r2Key: `shop/main/${id}/v3/file/b.png` })).toBe(own);
    // An earlier version's key is fine: a restore points back at it.
    expect(assetFileKey(scope, { ...asset, r2Key: `shop/main/${id}/a.png` })).toBe(
      `shop/main/${id}/a.png`,
    );
    // The media gate reads keys the same way, at the snapshot's version.
    const gate = assetGateEntry(scope, {
      assetId: id,
      file: { url: '', fileName: 'a.png', contentType: 'image/png' },
      title: {},
      description: {},
      metadata: { altText: {}, tags: [] },
      publishedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      r2Key: `shop/main/${id}/v2/file/a.png`,
    });
    expect(gate?.r2Key).toBe(`shop/main/${id}/a.png`);
  });
});

describe('replacing an asset file', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('hands out an upload for the next version and changes nothing until the commit', async () => {
    const asset = await upload(h);
    const r = await replaceAssetFile(h.ctx, h.blob, scope, asset.id, {
      fileName: 'hero-2.png',
      contentType: 'image/png',
    });
    expect(r.commit).toEqual({
      version: 2,
      fileName: 'hero-2.png',
      contentType: 'image/png',
      attempt: expect.any(String),
    });
    // This attempt's own key for version 2.
    expect(h.blob.uploads.at(-1)?.key).toBe(
      `shop/main/${asset.id}/v2/file-${r.commit.attempt}/hero-2.png`,
    );
    expect((await getAsset(h.ctx, scope, asset.id)).version).toBe(1);
  });

  it('refuses to commit before the bytes are uploaded', async () => {
    const asset = await upload(h);
    const r = await replaceAssetFile(h.ctx, h.blob, scope, asset.id, {
      fileName: 'hero-2.png',
      contentType: 'image/png',
    });
    await expect(commitAssetFile(h.ctx, h.blob, scope, asset.id, r.commit)).rejects.toThrow(
      ValidationError,
    );
    expect(h.events().filter((e) => e.type === 'asset.file_replaced')).toEqual([]);
  });

  it('refuses a commit naming the file other than the upload was signed for', async () => {
    const asset = await upload(h);
    const r = await replaceAssetFile(h.ctx, h.blob, scope, asset.id, {
      fileName: 'hero-2.png',
      contentType: 'image/png',
    });
    await h.blob.put(
      assetObjectKey(scope, asset.id, 'hero-2.png', 2, r.commit.attempt),
      'v2',
      'image/png',
    );
    // The same key (only the last segment counts), a name the policy never checked.
    await expect(
      commitAssetFile(h.ctx, h.blob, scope, asset.id, {
        ...r.commit,
        fileName: 'unchecked name/hero-2.png',
      }),
    ).rejects.toThrow(ValidationError);
    expect((await commitAssetFile(h.ctx, h.blob, scope, asset.id, r.commit)).file.fileName).toBe(
      'hero-2.png',
    );
  });

  it('bumps the version, keeps the old file in history and starts ingest, in one unit', async () => {
    const asset = await upload(h);
    await h.store.assets.recordIngest(scope, asset.id, 1, {
      status: 'ready',
      contentHash: 'hash-1',
    });
    const updated = await replace(h, asset.id, 'hero-2.png');
    const key = updated.r2Key ?? '';
    expect(key).toMatch(new RegExp(`^shop/main/${asset.id}/v2/file-[^/]+/hero-2\\.png$`));
    expect(updated).toMatchObject({
      version: 2,
      r2Key: key,
      file: { fileName: 'hero-2.png', contentType: 'image/png', size: 'hero-2.png-bytes'.length },
    });
    const stored = await getAsset(h.ctx, scope, asset.id);
    // What ingest found about the old file says nothing about the new one.
    expect(stored.contentHash).toBeUndefined();
    expect(stored.ingestStatus).toBeUndefined();
    expect(await h.store.assets.listVersions(scope, asset.id)).toEqual([
      expect.objectContaining({
        version: 1,
        r2Key: `shop/main/${asset.id}/hero.png`,
        contentHash: 'hash-1',
        replacedBy: 'ana@example.com',
      }),
    ]);
    const replaced = h.events().find((e) => e.type === 'asset.file_replaced');
    expect(replaced).toMatchObject({
      assetId: asset.id,
      version: 2,
      previousVersion: 1,
      r2Key: key,
      etag: expect.any(String),
    });
    await h.drain();
    // The same message an upload sends, naming the bytes: R2's own notice starts no second run.
    expect(h.ingest.created).toEqual([
      {
        key,
        etag: (replaced as { etag: string }).etag,
      },
    ]);
  });

  it('treats a retried commit as done, and a commit that lost a race as a conflict', async () => {
    const asset = await upload(h);
    const first = await replaceAssetFile(h.ctx, h.blob, scope, asset.id, {
      fileName: 'a.png',
      contentType: 'image/png',
    });
    const second = await replaceAssetFile(h.ctx, h.blob, scope, asset.id, {
      fileName: 'b.png',
      contentType: 'image/png',
    });
    for (const r of [first, second]) {
      await h.blob.put(
        assetObjectKey(scope, asset.id, r.commit.fileName, r.commit.version, r.commit.attempt),
        r.commit.fileName,
        'image/png',
      );
    }
    await commitAssetFile(h.ctx, h.blob, scope, asset.id, first.commit);
    // The response was lost and the client tries again: nothing more happens.
    const again = await commitAssetFile(h.ctx, h.blob, scope, asset.id, first.commit);
    expect(again.version).toBe(2);
    await expect(commitAssetFile(h.ctx, h.blob, scope, asset.id, second.commit)).rejects.toThrow(
      ConflictError,
    );
    expect(h.events().filter((e) => e.type === 'asset.file_replaced')).toHaveLength(1);
    expect(await h.store.assets.listVersions(scope, asset.id)).toHaveLength(1);
  });

  it('turns a replace committed between the read and the write into a conflict', async () => {
    const asset = await upload(h);
    const r = await replaceAssetFile(h.ctx, h.blob, scope, asset.id, {
      fileName: 'a.png',
      contentType: 'image/png',
    });
    await h.blob.put(
      assetObjectKey(scope, asset.id, 'a.png', 2, r.commit.attempt),
      'a',
      'image/png',
    );
    // Another commit lands after this one read the asset, before its unit runs.
    const withTransaction = h.store.withTransaction.bind(h.store);
    h.store.withTransaction = (async (fn) => {
      h.store.withTransaction = withTransaction;
      await h.store.assets.replaceFile(
        scope,
        { ...asset, version: 2, r2Key: assetObjectKey(scope, asset.id, 'b.png', 2) },
        { version: 1, file: asset.file, replacedAt: '2026-01-01T00:00:00.000Z' },
      );
      return withTransaction(fn);
    }) as typeof h.store.withTransaction;
    await expect(commitAssetFile(h.ctx, h.blob, scope, asset.id, r.commit)).rejects.toThrow(
      ConflictError,
    );
  });

  it('keeps delivering the published file until a republish, which retires the old version', async () => {
    const asset = await upload(h);
    await publishAsset(h.ctx, scope, asset.id);
    const v2Key = (await replace(h, asset.id, 'hero-2.png')).r2Key;
    const live = await getPublishedAsset(h.ctx, scope, asset.id);
    expect(live).toMatchObject({ version: 1, r2Key: `shop/main/${asset.id}/hero.png` });
    await h.drain();
    expect(await h.gate.get(scope, asset.id)).toMatchObject({ v: 1 });

    await publishAsset(h.ctx, scope, asset.id);
    expect(await getPublishedAsset(h.ctx, scope, asset.id)).toMatchObject({
      version: 2,
      r2Key: v2Key,
    });
    expect(
      h
        .events()
        .filter((e) => e.type === 'asset.published')
        .at(-1),
    ).toMatchObject({
      replacedVersion: 1,
    });
    await h.drain();
    expect(await h.gate.get(scope, asset.id)).toMatchObject({
      v: 2,
      r2Key: v2Key,
    });
    // A republish of the same file names nothing replaced.
    await publishAsset(h.ctx, scope, asset.id);
    expect(
      h
        .events()
        .filter((e) => e.type === 'asset.published')
        .at(-1),
    ).not.toHaveProperty('replacedVersion');
  });

  it('refuses a hosted video', async () => {
    const asset = await upload(h);
    await h.store.assets.save(scope, {
      ...asset,
      file: {
        ...asset.file,
        video: { provider: 'stream', videoId: 'v1', status: 'ready' },
      },
    });
    await expect(
      replaceAssetFile(h.ctx, h.blob, scope, asset.id, {
        fileName: 'b.mp4',
        contentType: 'video/mp4',
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('asset version history', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('lists every file newest first, with who made each current and which one is live', async () => {
    const asset = await upload(h);
    await publishAsset(h.ctx, scope, asset.id);
    (h.ctx.clock as FixedClock).advance(60_000);
    await replace(h, asset.id, 'hero-2.png');
    const versions = await listAssetVersions(h.ctx, scope, asset.id, { blob: h.blob });
    expect(versions.map((v) => [v.version, v.current, v.published])).toEqual([
      [2, true, false],
      [1, false, true],
    ]);
    expect(versions[0]).toMatchObject({
      createdAt: '2026-01-01T00:01:00.000Z',
      createdBy: 'ana@example.com',
    });
    expect(versions[1]?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    // Signed and short-lived, never the stored URL.
    expect(versions[1]?.file.url).toContain(`${asset.id}/hero.png?ttl=`);
  });

  it('restores an older file as a new version pointing at the same bytes', async () => {
    const asset = await upload(h);
    await h.store.assets.recordIngest(scope, asset.id, 1, { contentHash: 'hash-1' });
    await replace(h, asset.id, 'hero-2.png');
    const restored = await restoreAssetVersion(h.ctx, h.blob, scope, asset.id, 1, {
      by: 'bo@example.com',
    });
    expect(restored).toMatchObject({
      version: 3,
      r2Key: `shop/main/${asset.id}/hero.png`,
      contentHash: 'hash-1',
      file: { fileName: 'hero.png' },
    });
    expect(
      h
        .events()
        .filter((e) => e.type === 'asset.file_replaced')
        .at(-1),
    ).toMatchObject({
      version: 3,
      previousVersion: 2,
      restoredFrom: 1,
      r2Key: `shop/main/${asset.id}/hero.png`,
    });
    const versions = await listAssetVersions(h.ctx, scope, asset.id);
    expect(versions.map((v) => [v.version, v.restoredFrom])).toEqual([
      [3, 1],
      [2, undefined],
      [1, undefined],
    ]);
    // Reads serve the restored file.
    expect((await withReadUrl(h.blob, scope, restored)).file.url).toContain(
      `${asset.id}/hero.png?ttl=`,
    );
    // Publishing it delivers the restored bytes under v3's URLs.
    await publishAsset(h.ctx, scope, asset.id);
    expect(await getPublishedAsset(h.ctx, scope, asset.id)).toMatchObject({
      version: 3,
      r2Key: `shop/main/${asset.id}/hero.png`,
    });
  });

  it('refuses to restore the current version or one the asset never had', async () => {
    const asset = await upload(h);
    await expect(restoreAssetVersion(h.ctx, h.blob, scope, asset.id, 1)).rejects.toThrow(
      ValidationError,
    );
    await expect(restoreAssetVersion(h.ctx, h.blob, scope, asset.id, 7)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('refuses to restore a version whose bytes are gone', async () => {
    const asset = await upload(h);
    await replace(h, asset.id, 'hero-2.png');
    await h.blob.delete(`shop/main/${asset.id}/hero.png`);
    await expect(restoreAssetVersion(h.ctx, h.blob, scope, asset.id, 1)).rejects.toThrow(
      ValidationError,
    );
  });

  it('keeps one environment’s history out of another’s', async () => {
    const asset = await upload(h);
    await replace(h, asset.id, 'hero-2.png');
    await createEnvironment(h.ctx, 'shop', 'staging');
    const staging = { spaceId: 'shop', environmentId: 'staging' };
    await h.store.assets.create(staging, { ...asset });
    expect(await h.store.assets.listVersions(staging, asset.id)).toEqual([]);
    expect(await h.store.assets.getVersion(staging, asset.id, 1)).toBeNull();
  });
});

describe('deleting a versioned asset', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('removes every version’s file and what was derived from each, and the history', async () => {
    const asset = await upload(h);
    await replace(h, asset.id, 'hero-2.png');
    await h.blob.put(`shop/main/${asset.id}/v1/text.md`, 'text', 'text/markdown');
    await h.blob.put(`shop/main/${asset.id}/v2/text.md`, 'text', 'text/markdown');
    const other = await upload(h, 'other.png');
    await archiveAsset(h.ctx, scope, asset.id);
    await deleteAsset(h.ctx, scope, asset.id);
    await h.drain();
    expect(h.blob.keys().filter((k) => k.includes(asset.id))).toEqual([]);
    expect(h.blob.keys()).toContain(`shop/main/${other.id}/other.png`);
    expect(await h.store.assets.listVersions(scope, asset.id)).toEqual([]);
  });

  it('keeps the files while another environment still has the asset, but drops derived text', async () => {
    const asset = await upload(h);
    const v2Key = (await replace(h, asset.id, 'hero-2.png')).r2Key ?? '';
    await h.blob.put(`shop/main/${asset.id}/v2/text.md`, 'text', 'text/markdown');
    await createEnvironment(h.ctx, 'shop', 'staging');
    await h.store.assets.create(
      { spaceId: 'shop', environmentId: 'staging' },
      await getAsset(h.ctx, scope, asset.id),
    );
    await deleteAssetFiles(h.ctx, { blob: h.blob }, { scope, assetId: asset.id, r2Key: v2Key });
    expect(
      h.blob
        .keys()
        .filter((k) => k.includes(asset.id))
        .sort(),
    ).toEqual([`shop/main/${asset.id}/hero.png`, v2Key]);
  });

  it('keeps the files while a clone in another space still names them', async () => {
    const asset = await upload(h);
    const key = assetFileKey(scope, asset);
    const outlet = { spaceId: 'outlet', environmentId: 'main' };
    await createSpace(h.ctx, { spaceId: 'outlet', name: 'Outlet', defaultLocale: 'en-US' });
    await cloneEnvironment(h.ctx, scope, outlet);
    // A clone keeps its source's keys rather than copying the bytes.
    expect(assetFileKey(outlet, await getAsset(h.ctx, outlet, asset.id))).toBe(key);
    await archiveAsset(h.ctx, scope, asset.id);
    await deleteAsset(h.ctx, scope, asset.id);
    await h.drain();
    expect(h.blob.keys()).toContain(key);
  });

  it('builds the delivered snapshot from the version’s own key', () => {
    const snapshot = publishedSnapshot(
      scope,
      {
        id: 'a1',
        status: 'draft',
        version: 4,
        r2Key: 'shop/main/a1/v4/file/x.png',
        file: { url: '', fileName: 'x.png', contentType: 'image/png' },
        title: {},
        description: {},
        metadata: { altText: {}, tags: [] },
      },
      new Date(0),
    );
    expect(snapshot).toMatchObject({ version: 4, r2Key: 'shop/main/a1/v4/file/x.png' });
  });
});
