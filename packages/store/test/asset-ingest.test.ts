import type { Asset } from '@commerceworker/domain';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * What asset ingest writes on D1 (0011_asset_ingest): `recordIngest` touches only ingest's
 * columns and the file's measurements, only while the asset is on the run's version; `save`
 * leaves ingest's columns as ingest wrote them; the duplicate lookup by hash. Each test makes
 * its own space.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const freshScope = () => ({ spaceId: `ingest-${uid()}`, environmentId: 'main' });

const asset = (over: Partial<Asset> = {}): Asset => {
  const id = over.id ?? uid();
  return {
    id,
    status: 'draft',
    file: {
      url: `/media/s/main/${id}/f.bin`,
      fileName: 'f.bin',
      contentType: 'application/octet-stream',
    },
    title: { 'en-US': 'Original title' },
    description: {},
    metadata: { altText: {}, tags: [] },
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
};

describe('asset ingest columns on D1', () => {
  it('records findings, measurements and a sniffed type without touching editorial fields', async () => {
    const scope = freshScope();
    const a = asset();
    await store.assets.create(scope, a);
    await store.assets.recordIngest(scope, a.id, 1, {
      status: 'ready',
      contentHash: 'ab'.repeat(32),
      duplicateOf: 'orig',
      size: 2048,
      width: 640,
      height: 480,
      contentType: 'image/png',
    });
    const got = await store.assets.get(scope, a.id);
    expect(got).toMatchObject({
      ingestStatus: 'ready',
      contentHash: 'ab'.repeat(32),
      duplicateOf: 'orig',
      title: { 'en-US': 'Original title' },
      file: {
        url: a.file.url,
        fileName: 'f.bin',
        contentType: 'image/png',
        size: 2048,
        width: 640,
        height: 480,
      },
    });
    // The columns the library filters on follow the sniffed type.
    const images = await store.assets.list(scope, { filters: { kind: 'image' } });
    expect(images.items.map((x) => x.id)).toEqual([a.id]);
    // null clears; an omitted key is left.
    await store.assets.recordIngest(scope, a.id, 1, {
      status: 'error',
      error: 'boom',
      duplicateOf: null,
    });
    expect(await store.assets.get(scope, a.id)).toMatchObject({
      ingestStatus: 'error',
      ingestError: 'boom',
      contentHash: 'ab'.repeat(32),
    });
    expect((await store.assets.get(scope, a.id))?.duplicateOf).toBeUndefined();
  });

  it('drops findings for a version the asset has moved past', async () => {
    const scope = freshScope();
    const a = asset({ version: 2 });
    await store.assets.create(scope, a);
    await store.assets.recordIngest(scope, a.id, 1, {
      status: 'ready',
      contentHash: 'cd'.repeat(32),
    });
    const got = await store.assets.get(scope, a.id);
    expect(got?.ingestStatus).toBeUndefined();
    expect(got?.contentHash).toBeUndefined();
  });

  it('a save from a read taken before ingest keeps what ingest recorded', async () => {
    const scope = freshScope();
    const a = asset();
    await store.assets.create(scope, a);
    const stale = (await store.assets.get(scope, a.id)) as Asset;
    await store.assets.recordIngest(scope, a.id, 1, {
      status: 'ready',
      contentHash: 'ef'.repeat(32),
    });
    await store.assets.save(scope, {
      ...stale,
      title: { 'en-US': 'Edited' },
      aiSuggestions: { altText: ['en-US'] },
    });
    expect(await store.assets.get(scope, a.id)).toMatchObject({
      title: { 'en-US': 'Edited' },
      ingestStatus: 'ready',
      contentHash: 'ef'.repeat(32),
      aiSuggestions: { altText: ['en-US'] },
    });
  });

  it('finds assets by hash in their own scope only, oldest first', async () => {
    const scope = freshScope();
    const other = freshScope();
    const hash = '12'.repeat(32);
    const older = asset({ createdAt: '2025-01-01T00:00:00.000Z' });
    const newer = asset({ createdAt: '2026-06-01T00:00:00.000Z' });
    const elsewhere = asset();
    for (const [s, x] of [
      [scope, older],
      [scope, newer],
      [other, elsewhere],
    ] as const) {
      await store.assets.create(s, x);
      await store.assets.recordIngest(s, x.id, 1, { contentHash: hash });
    }
    await store.assets.create(scope, asset());
    const page = await store.assets.list(scope, {
      filters: { contentHash: hash, status: 'all' },
      sort: { field: 'createdAt', direction: 'asc' },
    });
    expect(page.items.map((x) => x.id)).toEqual([older.id, newer.id]);
  });

  it('applies a status write only from the statuses it names (pending never over processing)', async () => {
    const scope = freshScope();
    const a = asset();
    await store.assets.create(scope, a);
    const pendingUnlessRunning = {
      status: 'pending' as const,
      onlyFrom: [null, 'pending', 'ready', 'error'] as const,
    };
    // Never ingested (NULL) counts as one of them.
    await store.assets.recordIngest(scope, a.id, 1, pendingUnlessRunning);
    expect((await store.assets.get(scope, a.id))?.ingestStatus).toBe('pending');
    await store.assets.recordIngest(scope, a.id, 1, { status: 'processing' });
    await store.assets.recordIngest(scope, a.id, 1, pendingUnlessRunning);
    expect((await store.assets.get(scope, a.id))?.ingestStatus).toBe('processing');
    // Restoring a finished status only while it is still pending.
    await store.assets.recordIngest(scope, a.id, 1, { status: 'ready', onlyFrom: ['pending'] });
    expect((await store.assets.get(scope, a.id))?.ingestStatus).toBe('processing');
  });

  it('writes measurements into the published snapshot of the same version only, in a unit', async () => {
    const scope = freshScope();
    const a = asset({ status: 'published' });
    await store.assets.create(scope, a);
    const snapshot = {
      assetId: a.id,
      file: a.file,
      title: a.title,
      description: a.description,
      metadata: a.metadata,
      publishedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    };
    await store.assets.putPublished(scope, snapshot);
    await store.assets.recordPublishedFile(scope, a.id, 2, { width: 1, height: 1 });
    expect((await store.assets.getPublished(scope, a.id))?.file.width).toBeUndefined();
    await store.withTransaction(async (tx) => {
      await tx.assets.recordIngest(scope, a.id, 1, { status: 'ready' });
      await tx.assets.recordPublishedFile(scope, a.id, 1, { size: 9, width: 640, height: 480 });
    });
    expect((await store.assets.getPublished(scope, a.id))?.file).toMatchObject({
      url: a.file.url,
      fileName: 'f.bin',
      size: 9,
      width: 640,
      height: 480,
    });
  });

  it('writes a placeholder into the file record as an object, and into the snapshot', async () => {
    const scope = freshScope();
    const a = asset({ status: 'published' });
    await store.assets.create(scope, a);
    await store.assets.putPublished(scope, {
      assetId: a.id,
      file: a.file,
      title: a.title,
      description: a.description,
      metadata: a.metadata,
      publishedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    });
    // Quotes and a slash: stored as JSON, never as a string that merely looks like it.
    const placeholder = { thumbhash: 'ab/"c+==', dominantColor: '#a07850' };
    await store.withTransaction(async (tx) => {
      await tx.assets.recordIngest(scope, a.id, 1, { width: 4, placeholder });
      await tx.assets.recordPublishedFile(scope, a.id, 1, { placeholder });
    });
    expect((await store.assets.get(scope, a.id))?.file).toMatchObject({
      url: a.file.url,
      width: 4,
      placeholder,
    });
    expect((await store.assets.getPublished(scope, a.id))?.file.placeholder).toEqual(placeholder);
  });
});

describe('a purge’s progress mark on D1', () => {
  it('commits with the unit it is in, and not without it', async () => {
    const spaceId = `purge-${uid()}`;
    await testDb
      .prepare(
        'INSERT INTO environment_purges (space_id, environment_id, requested_at, nudged_at) VALUES (?, ?, 0, ?)',
      )
      .bind(spaceId, 'gone', 0)
      .run();
    const at = new Date('2026-06-01T00:00:00.000Z');
    await expect(
      store.withTransaction(async (tx) => {
        await tx.spaces.markEnvironmentPurgeProgress(spaceId, 'gone', at);
        throw new Error('the hand-off failed');
      }),
    ).rejects.toThrow('the hand-off failed');
    const stalled = await store.spaces.claimStalledPurges(new Date('2026-01-01'), at, 100);
    expect(stalled).toContainEqual({ spaceId, environmentId: 'gone' });
  });
});

describe('drafts awaiting their upload on D1 (0014_asset_upload_sweep)', () => {
  // Creation times far from every other test's, so the cross-scope read sees only these.
  const at = (minute: number) => new Date(Date.UTC(2001, 0, 1, 0, minute)).toISOString();

  it('lists unmeasured, never-ingested drafts across scopes, oldest first, before the cutoff', async () => {
    const one = freshScope();
    const two = freshScope();
    const key = (s: { spaceId: string }, id: string) => `${s.spaceId}/main/${id}/f.bin`;
    const make = async (s: typeof one, minute: number, over: Partial<Asset> = {}) => {
      const id = uid();
      const a = asset({ id, createdAt: at(minute), r2Key: key(s, id), ...over });
      await store.assets.create(s, a);
      return a;
    };
    const second = await make(one, 2);
    const first = await make(two, 1);
    const measured = await make(one, 3);
    await store.assets.recordIngest(one, measured.id, 1, { size: 9 });
    const ingested = await make(two, 4);
    await store.assets.recordIngest(two, ingested.id, 1, { status: 'pending' });
    await make(one, 5, { status: 'published' });
    await make(one, 6, { r2Key: undefined }); // no key of its own: a hosted video's shape
    const late = await make(one, 30);

    const found = await store.assets.listAwaitingUpload(new Date(at(20)), 10);
    expect(found.map((f) => f.asset.id)).toEqual([first.id, second.id]);
    expect(found[0]?.scope).toEqual(two);
    expect(found[1]?.scope).toEqual(one);
    expect((await store.assets.listAwaitingUpload(new Date(at(20)), 1)).length).toBe(1);
    expect(
      (await store.assets.listAwaitingUpload(new Date(at(40)), 10)).map((f) => f.asset.id),
    ).toContain(late.id);
  });

  it('reads them through the partial index, not a scan of the library', async () => {
    const plan = await testDb
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM assets WHERE status = 'draft' AND ingest_status IS NULL " +
          'AND size IS NULL AND r2_key IS NOT NULL AND created_at > 0 AND created_at < ? ' +
          'ORDER BY created_at LIMIT 50',
      )
      .bind(Date.now())
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join('\n')).toContain('assets_awaiting_upload');
  });
});
