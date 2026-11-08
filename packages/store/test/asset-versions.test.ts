import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import {
  type AppContext,
  commitAssetFile,
  createAsset,
  createSpace,
  expireAsset,
  publishAsset,
  replaceAssetFile,
  restoreAssetVersion,
  runDueAssetExpiries,
  setAssetRights,
} from '@commerceworker/application';
import type { Asset } from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { FakeBlobStore, FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * File versions and rights expiry on D1: the replace unit's compare-and-set on the version, the
 * history it keeps, the snapshot's `expires_at` column (0015_asset_expiry) and the sweep's
 * cross-scope read of it, and the guard that leaves a republished asset alone. The file shares one
 * database: each test makes its own space.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();

async function harness(start = '2026-01-01T00:00:00.000Z') {
  const clock = new FixedClock(new Date(start));
  const ctx: AppContext = { store, clock, ids: { newId: uid } };
  const spaceId = `ver-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Versions', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
  const blob = new FakeBlobStore();
  const upload = async (fileName = 'hero.png') => {
    const { asset } = await createAsset(ctx, blob, scope, { fileName, contentType: 'image/png' });
    await blob.put(asset.r2Key ?? '', 'v1', 'image/png');
    return asset;
  };
  const replace = async (id: string, fileName: string) => {
    const r = await replaceAssetFile(ctx, blob, scope, id, { fileName, contentType: 'image/png' });
    await blob.put(
      `${spaceId}/main/${id}/v${r.commit.version}/file-${r.commit.attempt}/${fileName}`,
      fileName,
      'image/png',
    );
    return commitAssetFile(ctx, blob, scope, id, r.commit, { by: 'ana@example.com' });
  };
  return { ctx, clock, scope, blob, upload, replace };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe('asset versions on D1', () => {
  it('keeps the replaced file in history and resets what ingest found', async () => {
    const h = await harness();
    const asset = await h.upload();
    await store.assets.recordIngest(h.scope, asset.id, 1, {
      status: 'ready',
      contentHash: 'abc',
      duplicateOf: 'other',
    });
    const replaced = await h.replace(asset.id, 'hero-2.png');
    const stored = await store.assets.get(h.scope, asset.id);
    expect(replaced.r2Key).toMatch(/\/v2\/file-[^/]+\/hero-2\.png$/);
    expect(stored).toMatchObject({
      version: 2,
      r2Key: replaced.r2Key,
      file: { fileName: 'hero-2.png', size: 'hero-2.png'.length },
    });
    expect(stored?.contentHash).toBeUndefined();
    expect(stored?.ingestStatus).toBeUndefined();
    expect(stored?.duplicateOf).toBeUndefined();
    // The columns the library filters on follow the new file.
    const row = await testDb
      .prepare('select size, kind, mime from assets where space_id = ? and id = ?')
      .bind(h.scope.spaceId, asset.id)
      .first();
    expect(row).toEqual({ size: 'hero-2.png'.length, kind: 'image', mime: 'image/png' });
    expect(await store.assets.listVersions(h.scope, asset.id)).toEqual([
      {
        version: 1,
        file: asset.file,
        r2Key: `${h.scope.spaceId}/main/${asset.id}/hero.png`,
        contentHash: 'abc',
        replacedAt: '2026-01-01T00:00:00.000Z',
        replacedBy: 'ana@example.com',
      },
    ]);
    expect(await store.assets.getVersion(h.scope, asset.id, 1)).toMatchObject({ version: 1 });
    expect(await store.assets.getVersion(h.scope, asset.id, 2)).toBeNull();
    // Another environment sees none of it.
    expect(
      await store.assets.listVersions({ spaceId: h.scope.spaceId, environmentId: 'x' }, asset.id),
    ).toEqual([]);
  });

  it('keeps a committed replace when a save from an earlier read lands after it', async () => {
    const h = await harness();
    const asset = await h.upload();
    const stale = await store.assets.get(h.scope, asset.id);
    await h.replace(asset.id, 'hero-2.png');
    // An editor's metadata save, made from the v1 read.
    await store.assets.save(h.scope, {
      ...(stale as Asset),
      metadata: { ...(stale as Asset).metadata, altText: { 'en-US': 'A hero' } },
    });
    const now = (await store.assets.get(h.scope, asset.id)) as Asset;
    expect(now.version).toBe(2);
    expect(now.file.fileName).toBe('hero-2.png');
    expect(now.metadata.altText).toEqual({ 'en-US': 'A hero' });
    // The history still holds v1 once, and the next replace takes v3.
    await h.replace(asset.id, 'hero-3.png');
    const versions = await store.assets.listVersions(h.scope, asset.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(((await store.assets.get(h.scope, asset.id)) as Asset).version).toBe(3);
  });

  it('refuses a replace whose asset moved to another version, writing nothing', async () => {
    const h = await harness();
    const asset = await h.upload();
    await h.replace(asset.id, 'hero-2.png');
    const stale: Asset = { ...asset, version: 2, r2Key: 'x' };
    await expect(
      store.withTransaction((tx) =>
        tx.assets.replaceFile(h.scope, stale, {
          version: 1,
          file: asset.file,
          replacedAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(TransactionConflictError);
    expect((await store.assets.get(h.scope, asset.id))?.r2Key).not.toBe('x');
    expect(await store.assets.listVersions(h.scope, asset.id)).toHaveLength(1);
  });

  it('restores a version as a new one and deletes the whole history with the asset', async () => {
    const h = await harness();
    const asset = await h.upload();
    await h.replace(asset.id, 'hero-2.png');
    const restored = await restoreAssetVersion(h.ctx, h.blob, h.scope, asset.id, 1);
    expect(restored).toMatchObject({ version: 3, r2Key: asset.r2Key });
    expect((await store.assets.listVersions(h.scope, asset.id)).map((v) => v.version)).toEqual([
      2, 1,
    ]);
    await store.withTransaction((tx) => tx.assets.delete(h.scope, asset.id));
    expect(await store.assets.listVersions(h.scope, asset.id)).toEqual([]);
  });
});

describe('asset expiry on D1', () => {
  it('copies the expiry into its column on publish and on a rights change, and clears it', async () => {
    const h = await harness();
    const asset = await h.upload();
    const expiresAt = '2026-01-02T00:00:00.000Z';
    await setAssetRights(h.ctx, h.scope, asset.id, { expiresAt });
    await publishAsset(h.ctx, h.scope, asset.id);
    const column = async () =>
      (
        await testDb
          .prepare('select expires_at from asset_published where space_id = ? and asset_id = ?')
          .bind(h.scope.spaceId, asset.id)
          .first<{ expires_at: number | null }>()
      )?.expires_at;
    expect(await column()).toBe(Date.parse(expiresAt));
    await setAssetRights(h.ctx, h.scope, asset.id, { expiresAt: '2026-01-03T00:00:00Z' });
    expect(await column()).toBe(Date.parse('2026-01-03T00:00:00Z'));
    await setAssetRights(h.ctx, h.scope, asset.id, null);
    expect(await column()).toBeNull();
  });

  it('finds what expired across spaces, soonest first, past the parameter cap', async () => {
    const h = await harness();
    const other = await harness();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const ids: string[] = [];
    // 105 snapshots, written straight to the store: more than D1 binds in one statement.
    for (let i = 0; i < 105; i++) {
      const id = uid();
      ids.push(id);
      await store.assets.putPublished(i % 2 ? h.scope : other.scope, {
        assetId: id,
        file: { url: '', fileName: 'f.png', contentType: 'image/png' },
        title: {},
        description: {},
        metadata: { altText: {}, tags: [] },
        publishedAt: iso(base),
        version: 1,
        rights: { expiresAt: iso(base - (i + 1) * 1000) },
      });
    }
    const found = await store.assets.findExpiredPublished(new Date(base), 1000);
    const mine = found.filter((f) => ids.includes(f.assetId));
    expect(mine).toHaveLength(105);
    // Soonest first: the last written expired earliest.
    expect(mine[0]?.assetId).toBe(ids[104]);
    expect(mine.some((f) => f.scope.spaceId === other.scope.spaceId)).toBe(true);
    const page = await store.assets.findExpiredPublished(new Date(base), 3);
    expect(page).toHaveLength(3);
    // Nothing expires before its time.
    expect(
      (await store.assets.findExpiredPublished(new Date(base - 200_000), 1000)).filter((f) =>
        ids.includes(f.assetId),
      ),
    ).toEqual([]);
  });

  it('passes over a row whose column is stale (an older writer kept it), so it never blocks the line', async () => {
    const h = await harness();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const id = uid();
    await store.assets.putPublished(h.scope, {
      assetId: id,
      file: { url: '', fileName: 'f.png', contentType: 'image/png' },
      title: {},
      description: {},
      metadata: { altText: {}, tags: [] },
      publishedAt: iso(base),
      version: 1,
      rights: { expiresAt: iso(base + 86_400_000) },
    });
    // Code that predates the column republished it with a later expiry and left the column past.
    await testDb
      .prepare('update asset_published set expires_at = ? where space_id = ? and asset_id = ?')
      .bind(base - 1000, h.scope.spaceId, id)
      .run();
    const found = await store.assets.findExpiredPublished(new Date(base), 1000);
    expect(found.map((f) => f.assetId)).not.toContain(id);
    // Due to the millisecond (julianday is a float): an expiry exactly at the sweep's instant counts.
    expect(
      (await store.assets.findExpiredPublished(new Date(base + 86_400_000), 1000)).map(
        (f) => f.assetId,
      ),
    ).toContain(id);
  });

  it('unpublishes an expired asset once, and leaves one whose expiry moved', async () => {
    const h = await harness();
    const due = await h.upload();
    const moved = await h.upload();
    for (const a of [due, moved]) {
      await setAssetRights(h.ctx, h.scope, a.id, { expiresAt: '2026-01-01T01:00:00Z' });
      await publishAsset(h.ctx, h.scope, a.id);
    }
    h.clock.advance(3_600_000);
    // The rights moved after the sweep's read: the guard refuses at commit.
    await setAssetRights(h.ctx, h.scope, moved.id, { expiresAt: '2026-01-05T00:00:00Z' });
    await expect(
      store.withTransaction((tx) =>
        tx.assets.removeExpiredPublished(h.scope, moved.id, h.clock.now()),
      ),
    ).rejects.toThrow(TransactionConflictError);
    expect(await expireAsset(h.ctx, h.scope, moved.id, h.clock.now())).toBe(false);

    const result = await runDueAssetExpiries(h.ctx, { limit: 1000 });
    expect(result.failed).toBe(0);
    expect(await store.assets.getPublished(h.scope, due.id)).toBeNull();
    expect((await store.assets.get(h.scope, due.id))?.status).toBe('draft');
    expect(await store.assets.getPublished(h.scope, moved.id)).not.toBeNull();
    const events = await testDb
      .prepare(
        `select type from outbox where json_extract(payload, '$.assetId') = ? order by rowid`,
      )
      .bind(due.id)
      .all<{ type: string }>();
    expect(events.results.map((r) => r.type).slice(-2)).toEqual([
      'asset.unpublished',
      'asset.expired',
    ]);
    // Once out, it is no longer found.
    expect(await expireAsset(h.ctx, h.scope, due.id, h.clock.now())).toBe(false);
  });
});

describe('the 0015 backfill', () => {
  it('fills expires_at from the rights of snapshots published before it, and only those', async () => {
    const spaceId = `ver-${uid()}`;
    const insert = (id: string, rights: unknown) =>
      testDb
        .prepare(
          `insert into asset_published (space_id, environment_id, asset_id, file, title, description, published_at, rights)
           values (?, 'main', ?, '{"url":"","fileName":"f","contentType":"image/png"}', '{}', '{}', 1767225600000, ?)`,
        )
        .bind(spaceId, id, rights === null ? null : JSON.stringify(rights))
        .run();
    await insert('dated', { expiresAt: '2026-02-01T12:30:00.000Z', credit: 'x' });
    await insert('zoned', { expiresAt: '2026-02-01T14:30:00+02:00' });
    await insert('none', { credit: 'x' });
    await insert('bare', null);
    await insert('junk', { expiresAt: 'soon' });

    const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    const expiry = migrations.find((m) => m.name.startsWith('0015_asset_expiry'));
    const updates = (expiry?.queries ?? []).filter((q) => /UPDATE `asset_published`/.test(q));
    expect(updates).toHaveLength(1);
    for (const q of updates) await testDb.prepare(q).run();

    const rows = await testDb
      .prepare(
        'select asset_id, expires_at from asset_published where space_id = ? order by asset_id',
      )
      .bind(spaceId)
      .all();
    expect(rows.results).toEqual([
      { asset_id: 'bare', expires_at: null },
      { asset_id: 'dated', expires_at: Date.parse('2026-02-01T12:30:00.000Z') },
      { asset_id: 'junk', expires_at: null },
      { asset_id: 'none', expires_at: null },
      { asset_id: 'zoned', expires_at: Date.parse('2026-02-01T12:30:00.000Z') },
    ]);
  });
});
