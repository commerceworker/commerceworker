import { ConflictError, NotFoundError, ValidationError } from '@commerceworker/domain';
import {
  FakeAssetIngestQueue,
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ABANDONED_MULTIPART_TTL_MS,
  type AppContext,
  abortMultipartAssetUpload,
  assetFileKey,
  assetObjectKey,
  commitAssetFile,
  completeMultipartAssetUpload,
  createAsset,
  createSpace,
  DEFAULT_PART_BYTES,
  multipartPlan,
  partLength,
  replaceAssetFile,
  restoreAssetVersion,
  signAssetUploadParts,
  startMultipartAssetFileReplacement,
  startMultipartAssetUpload,
  sweepAbandonedMultipartUploads,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };
const MiB = 1024 * 1024;

describe('multipart uploads', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  let blob: FakeBlobStore;
  let clock: FixedClock;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    blob = new FakeBlobStore();
    clock = new FixedClock();
    ctx = { store, clock, ids: new SequenceIdGenerator('u') };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('plans equal parts but the last, growing the part size past 10,000 parts', () => {
    expect(multipartPlan(250 * MiB)).toEqual({ partSize: DEFAULT_PART_BYTES, partCount: 32 });
    const huge = multipartPlan(200 * 1024 * MiB);
    expect(huge.partCount).toBeLessThanOrEqual(10_000);
    expect(huge.partSize % MiB).toBe(0);
    const upload = { size: 20 * MiB + 3, partSize: 8 * MiB };
    expect([1, 2, 3].map((n) => partLength(upload, n))).toEqual([8 * MiB, 8 * MiB, 4 * MiB + 3]);
  });

  it('starts, signs exact-length parts, completes and hands the file to ingest', async () => {
    const ingest = new FakeAssetIngestQueue();
    const size = 2 * DEFAULT_PART_BYTES + 5;
    const started = await startMultipartAssetUpload(
      ctx,
      blob,
      scope,
      { fileName: '../../other/film.mov', contentType: 'video/quicktime', size },
      { createdBy: 'ann' },
    );
    const { asset, upload } = started;
    // The key follows the single PUT's rules: this scope, this asset, a safe file name.
    expect(asset.r2Key).toBe(`shop/main/${asset.id}/film.mov`);
    expect(upload.partCount).toBe(3);
    const { parts } = await signAssetUploadParts(
      ctx,
      blob,
      scope,
      asset.id,
      upload.uploadId,
      [3, 1, 2],
    );
    expect(parts.map((p) => [p.partNumber, p.length])).toEqual([
      [3, 5],
      [1, DEFAULT_PART_BYTES],
      [2, DEFAULT_PART_BYTES],
    ]);
    const uploaded = [];
    for (const p of parts) {
      uploaded.push(
        await blob.multipart.uploadPart(
          asset.r2Key ?? '',
          upload.uploadId,
          p.partNumber,
          new Uint8Array(p.length),
        ),
      );
    }
    const done = await completeMultipartAssetUpload(
      ctx,
      { blob, ingest },
      scope,
      asset.id,
      upload.uploadId,
      uploaded,
    );
    expect(done.id).toBe(asset.id);
    expect((await blob.head(asset.r2Key ?? ''))?.size).toBe(size);
    expect(ingest.created).toEqual([{ key: asset.r2Key, etag: expect.stringMatching(/-3$/) }]);
    // Completing again (a retry whose answer was lost) answers with the same asset, and starts no
    // second ingest; one for an asset without bytes is a 404.
    const again = await completeMultipartAssetUpload(
      ctx,
      { blob, ingest },
      scope,
      asset.id,
      upload.uploadId,
      uploaded,
    );
    expect(again.id).toBe(asset.id);
    expect(ingest.created).toHaveLength(1);
    const empty = await startMultipartAssetUpload(ctx, blob, scope, {
      fileName: 'b.bin',
      contentType: 'application/octet-stream',
      size: 3,
    });
    await expect(
      completeMultipartAssetUpload(ctx, { blob, ingest }, scope, empty.asset.id, 'never', uploaded),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a size past the cap, bad part numbers, and an incomplete part list', async () => {
    const tight = { ...ctx, maxUploadBytes: 10 * MiB };
    await expect(
      startMultipartAssetUpload(tight, blob, scope, {
        fileName: 'a.bin',
        contentType: 'application/octet-stream',
        size: 10 * MiB + 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const { asset, upload } = await startMultipartAssetUpload(ctx, blob, scope, {
      fileName: 'a.bin',
      contentType: 'application/octet-stream',
      size: DEFAULT_PART_BYTES + 1,
    });
    for (const numbers of [
      [0],
      [3],
      [],
      Array.from({ length: 101 }, () => 1).map((_, i) => i + 1),
    ]) {
      await expect(
        signAssetUploadParts(ctx, blob, scope, asset.id, upload.uploadId, numbers),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(
      completeMultipartAssetUpload(ctx, { blob }, scope, asset.id, upload.uploadId, [
        { partNumber: 1, etag: 'e' },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      completeMultipartAssetUpload(ctx, { blob }, scope, asset.id, upload.uploadId, [
        { partNumber: 1, etag: 'e' },
        { partNumber: 1, etag: 'e' },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not let one scope sign or complete another scope’s upload', async () => {
    const { asset, upload } = await startMultipartAssetUpload(ctx, blob, scope, {
      fileName: 'a.bin',
      contentType: 'application/octet-stream',
      size: 10,
    });
    const other = { spaceId: 'shop', environmentId: 'staging' };
    await expect(
      signAssetUploadParts(ctx, blob, other, asset.id, upload.uploadId, [1]),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      abortMultipartAssetUpload(ctx, blob, other, asset.id, upload.uploadId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('aborts: the parts go, and the empty draft with them', async () => {
    const { asset, upload } = await startMultipartAssetUpload(ctx, blob, scope, {
      fileName: 'a.bin',
      contentType: 'application/octet-stream',
      size: 10,
    });
    await abortMultipartAssetUpload(ctx, blob, scope, asset.id, upload.uploadId);
    expect(blob.aborted).toEqual([upload.uploadId]);
    expect(await store.assets.get(scope, asset.id)).toBeNull();
  });

  it('sweeps uploads left unfinished a day on, once each', async () => {
    const { upload } = await startMultipartAssetUpload(ctx, blob, scope, {
      fileName: 'a.bin',
      contentType: 'application/octet-stream',
      size: 10,
    });
    expect(await sweepAbandonedMultipartUploads(ctx, blob)).toEqual({ aborted: 0, failed: 0 });
    clock.advance(ABANDONED_MULTIPART_TTL_MS + 1);
    expect(await sweepAbandonedMultipartUploads(ctx, blob)).toEqual({ aborted: 1, failed: 0 });
    expect(blob.aborted).toEqual([upload.uploadId]);
    expect(await sweepAbandonedMultipartUploads(ctx, blob)).toEqual({ aborted: 0, failed: 0 });
  });
});

describe('replacing a file in parts', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  let blob: FakeBlobStore;
  let clock: FixedClock;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    blob = new FakeBlobStore();
    clock = new FixedClock();
    ctx = { store, clock, ids: new SequenceIdGenerator('r') };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  /** An asset with its first file stored. */
  async function asset() {
    const created = await createAsset(ctx, blob, scope, {
      fileName: 'film.mov',
      contentType: 'video/quicktime',
    });
    await blob.put(assetFileKey(scope, created.asset), 'v1', 'video/quicktime');
    return created.asset;
  }

  /** Starts a replacement in parts and returns it with the key its parts go to. */
  async function start(id: string, fileName = 'cut.mov', size = big) {
    const started = await startMultipartAssetFileReplacement(ctx, blob, scope, id, {
      fileName,
      contentType: 'video/quicktime',
      size,
    });
    const row = (await store.assetUploads.listForAsset(scope, id)).find(
      (u) => u.uploadId === started.upload.uploadId,
    );
    return { ...started, key: row?.r2Key ?? '' };
  }

  /** Uploads every part the way a client does, and returns their etags. */
  async function sendParts(key: string, uploadId: string, size: number, partSize: number) {
    const out = [];
    for (let n = 1, at = 0; at < size; n++, at += partSize) {
      out.push(
        await blob.multipart.uploadPart(
          key,
          uploadId,
          n,
          new Uint8Array(Math.min(partSize, size - at)),
        ),
      );
    }
    return out;
  }

  /** A single-PUT replace: started, its bytes stored at its own key. */
  async function single(id: string, fileName: string, bytes: string) {
    const r = await replaceAssetFile(ctx, blob, scope, id, {
      fileName,
      contentType: 'video/quicktime',
    });
    const key = assetObjectKey(scope, id, r.commit.fileName, r.commit.version, r.commit.attempt);
    await blob.put(key, bytes, 'video/quicktime');
    return { ...r, key };
  }

  const big = 2 * DEFAULT_PART_BYTES + 7;

  it('uploads the next version in parts and commits it on completion, in the version-bump unit', async () => {
    const a = await asset();
    const started = await start(a.id, '../cut.mov');
    expect(started.version).toBe(2);
    expect(started.upload.partCount).toBe(3);
    // The attempt's own key for version 2.
    expect(started.key).toMatch(new RegExp(`^shop/main/${a.id}/v2/file-[^/]+/cut\\.mov$`));
    // Nothing changes until it completes.
    expect((await store.assets.get(scope, a.id))?.version ?? 1).toBe(1);
    const { parts } = await signAssetUploadParts(
      ctx,
      blob,
      scope,
      a.id,
      started.upload.uploadId,
      [1, 2, 3],
    );
    expect(parts.map((p) => p.length)).toEqual([DEFAULT_PART_BYTES, DEFAULT_PART_BYTES, 7]);
    const ingest = new FakeAssetIngestQueue();
    const uploaded = await sendParts(
      started.key,
      started.upload.uploadId,
      big,
      started.upload.partSize,
    );
    const done = await completeMultipartAssetUpload(
      ctx,
      { blob, ingest },
      scope,
      a.id,
      started.upload.uploadId,
      uploaded,
      { by: 'ann' },
    );
    expect(done.version).toBe(2);
    expect(done.r2Key).toBe(started.key);
    expect(done.file).toMatchObject({ fileName: 'cut.mov', size: big });
    // Ingest starts from the commit's event, not a second notice.
    expect(ingest.created).toEqual([]);
    const replaced = store.allEvents().filter((e) => e.type === 'asset.file_replaced');
    expect(replaced).toEqual([
      expect.objectContaining({ assetId: a.id, version: 2, previousVersion: 1 }),
    ]);
    // The upload went in the same unit.
    expect(await store.assetUploads.listForAsset(scope, a.id)).toEqual([]);
    // A retry whose answer was lost gets the committed asset back, and commits nothing twice.
    const again = await completeMultipartAssetUpload(
      ctx,
      { blob, ingest },
      scope,
      a.id,
      started.upload.uploadId,
      uploaded,
    );
    expect(again.version).toBe(2);
    expect(store.allEvents().filter((e) => e.type === 'asset.file_replaced')).toHaveLength(1);
  });

  it('refuses a size past the cap and a missing asset, as a single replace does', async () => {
    const a = await asset();
    await expect(
      startMultipartAssetFileReplacement({ ...ctx, maxUploadBytes: 10 * MiB }, blob, scope, a.id, {
        fileName: 'cut.mov',
        contentType: 'video/quicktime',
        size: 10 * MiB + 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      startMultipartAssetFileReplacement(ctx, blob, scope, 'missing', {
        fileName: 'cut.mov',
        contentType: 'video/quicktime',
        size: big,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(blob.uploadsInProgress.size).toBe(0);
  });

  it('gives every replace of one version its own key, even with the same file name', async () => {
    const a = await asset();
    const first = await single(a.id, 'cut.mov', 'first');
    const second = await single(a.id, 'cut.mov', 'second');
    const parts = await start(a.id, 'cut.mov');
    expect(new Set([first.key, second.key, parts.key]).size).toBe(3);
    expect(first.commit.version).toBe(second.commit.version);
    // Nothing either start did touched the other's bytes.
    expect(new TextDecoder().decode(blob.bytes(first.key) ?? undefined)).toBe('first');
    expect(new TextDecoder().decode(blob.bytes(second.key) ?? undefined)).toBe('second');
  });

  it('first commit wins: a later commit of another attempt for that version is 409, never a false success', async () => {
    const a = await asset();
    const mine = await single(a.id, 'cut.mov', 'mine');
    const theirs = await single(a.id, 'cut.mov', 'theirs');
    const committed = await commitAssetFile(ctx, blob, scope, a.id, theirs.commit);
    expect(committed.r2Key).toBe(theirs.key);
    // Same version, same name: before attempts this read as "already committed" and answered 200.
    await expect(commitAssetFile(ctx, blob, scope, a.id, mine.commit)).rejects.toBeInstanceOf(
      ConflictError,
    );
    // The winner's own retry still finds its work done.
    expect((await commitAssetFile(ctx, blob, scope, a.id, theirs.commit)).r2Key).toBe(theirs.key);
    expect(new TextDecoder().decode(blob.bytes(theirs.key) ?? undefined)).toBe('theirs');
  });

  it('a replacement in parts completing after another committed its version is 409, writes over nothing, and leaves no bytes', async () => {
    const a = await asset();
    const parts = await start(a.id, 'cut.mov');
    const uploaded = await sendParts(parts.key, parts.upload.uploadId, big, parts.upload.partSize);
    const other = await single(a.id, 'cut.mov', 'other');
    await commitAssetFile(ctx, blob, scope, a.id, other.commit);
    await expect(
      completeMultipartAssetUpload(ctx, { blob }, scope, a.id, parts.upload.uploadId, uploaded),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(blob.aborted).toContain(parts.upload.uploadId);
    expect(blob.bytes(parts.key)).toBeNull();
    expect(new TextDecoder().decode(blob.bytes(other.key) ?? undefined)).toBe('other');
    expect(await store.assetUploads.listForAsset(scope, a.id)).toEqual([]);
    expect((await store.assets.get(scope, a.id))?.r2Key).toBe(other.key);
  });

  it('a commit lost after the parts completed deletes this attempt’s bytes, and only them', async () => {
    const a = await asset();
    const parts = await start(a.id, 'cut.mov');
    const uploaded = await sendParts(parts.key, parts.upload.uploadId, big, parts.upload.partSize);
    const other = await single(a.id, 'cut.mov', 'other');
    // The other replace commits between the version check and the commit unit.
    const realGet = store.assets.get.bind(store.assets);
    let reads = 0;
    store.assets.get = async (s, id) => {
      const found = await realGet(s, id);
      if (id === a.id && ++reads === 1) await commitAssetFile(ctx, blob, scope, a.id, other.commit);
      return found;
    };
    await expect(
      completeMultipartAssetUpload(ctx, { blob }, scope, a.id, parts.upload.uploadId, uploaded),
    ).rejects.toBeInstanceOf(ConflictError);
    store.assets.get = realGet;
    expect(blob.bytes(parts.key)).toBeNull();
    expect(new TextDecoder().decode(blob.bytes(other.key) ?? undefined)).toBe('other');
    expect(await store.assetUploads.listForAsset(scope, a.id)).toEqual([]);
  });

  it('never completes over a version a restore took meanwhile: 409, upload dropped', async () => {
    const a = await asset();
    const v2 = await single(a.id, 'b.mov', 'v2');
    await commitAssetFile(ctx, blob, scope, a.id, v2.commit);
    const parts = await start(a.id, 'cut.mov');
    const uploaded = await sendParts(parts.key, parts.upload.uploadId, big, parts.upload.partSize);
    await restoreAssetVersion(ctx, blob, scope, a.id, 1);
    await expect(
      completeMultipartAssetUpload(ctx, { blob }, scope, a.id, parts.upload.uploadId, uploaded),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(blob.aborted).toContain(parts.upload.uploadId);
    expect(blob.bytes(parts.key)).toBeNull();
    expect(await store.assetUploads.listForAsset(scope, a.id)).toEqual([]);
    expect((await store.assets.get(scope, a.id))?.version).toBe(3);
  });

  it('aborting a replacement keeps the asset and its file, even a draft without bytes yet', async () => {
    const created = await createAsset(ctx, blob, scope, {
      fileName: 'film.mov',
      contentType: 'video/quicktime',
    });
    const started = await start(created.asset.id);
    await abortMultipartAssetUpload(ctx, blob, scope, created.asset.id, started.upload.uploadId);
    expect(blob.aborted).toEqual([started.upload.uploadId]);
    expect(await store.assets.get(scope, created.asset.id)).not.toBeNull();
  });

  it('refuses a commit whose attempt is not one a key can hold', async () => {
    const a = await asset();
    const r = await single(a.id, 'cut.mov', 'x');
    await expect(
      commitAssetFile(ctx, blob, scope, a.id, { ...r.commit, attempt: '../other' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('keeps another scope out of a replacement upload, and the sweep aborts one left behind', async () => {
    const a = await asset();
    const started = await start(a.id);
    const other = { spaceId: 'shop', environmentId: 'staging' };
    await expect(
      completeMultipartAssetUpload(ctx, { blob }, other, a.id, started.upload.uploadId, []),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await store.assetUploads.listForAsset(other, a.id)).toEqual([]);
    clock.advance(ABANDONED_MULTIPART_TTL_MS + 1);
    expect(await sweepAbandonedMultipartUploads(ctx, blob)).toEqual({ aborted: 1, failed: 0 });
    expect((await store.assets.get(scope, a.id))?.version ?? 1).toBe(1);
  });
});
