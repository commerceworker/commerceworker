import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Asset, AssetRendition } from '@commerceworker/domain';
import type { PublishedAsset, PublishedAssetQuery } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * What Delivery and the media Worker read on D1: the published snapshot's version, key, kind and
 * rights (0009), the published listing's keyset paging and filters, and the space's rendition
 * presets (0008). The file shares one database: each test makes its own space.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const freshScope = () => ({ spaceId: `dl-${uid()}`, environmentId: 'main' });

const snapshot = (
  id: string,
  at: number,
  over: Partial<PublishedAsset> & { contentType?: string; tags?: string[] } = {},
): PublishedAsset => {
  const { contentType = 'image/png', tags = [], ...rest } = over;
  return {
    assetId: id,
    file: { url: `/media/x/${id}`, fileName: `${id}.png`, contentType },
    title: { 'en-US': id },
    description: {},
    metadata: { altText: {}, tags },
    publishedAt: new Date(Date.UTC(2026, 0, 1) + at).toISOString(),
    ...rest,
  };
};

async function everything(
  scope: { spaceId: string; environmentId: string },
  query: PublishedAssetQuery,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.assets.listPublished(scope, {
      ...query,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...page.items.map((a) => a.assetId));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

describe('published asset snapshots', () => {
  it('keep the version, key and rights the media origin builds from', async () => {
    const scope = freshScope();
    await store.assets.putPublished(
      scope,
      snapshot('a', 0, {
        version: 3,
        r2Key: `${scope.spaceId}/main/a/a.png`,
        rights: { credit: 'Ada', expiresAt: '2030-01-01T00:00:00.000Z' },
      }),
    );
    expect(await store.assets.getPublished(scope, 'a')).toMatchObject({
      version: 3,
      r2Key: `${scope.spaceId}/main/a/a.png`,
      rights: { credit: 'Ada', expiresAt: '2030-01-01T00:00:00.000Z' },
    });
    // A republish replaces them all.
    await store.assets.putPublished(scope, snapshot('a', 1, { version: 4 }));
    const again = await store.assets.getPublished(scope, 'a');
    expect(again?.version).toBe(4);
    expect(again?.r2Key).toBeUndefined();
    expect(again?.rights).toBeUndefined();
  });

  it('page in publish order past 100 rows, stable while more are published', async () => {
    const scope = freshScope();
    // Two share a publish instant: the id breaks the tie.
    const ids = Array.from({ length: 130 }, (_, i) => `p${String(i).padStart(3, '0')}`);
    for (const [i, id] of ids.entries())
      await store.assets.putPublished(scope, snapshot(id, i === 1 ? 0 : i));
    const first = await store.assets.listPublished(scope, { limit: 60 });
    expect(first.items.map((a) => a.assetId)).toEqual(ids.slice(0, 60));
    // Published meanwhile, after everything listed so far: it shows up at the end, nothing repeats.
    await store.assets.putPublished(scope, snapshot('late', 10_000));
    const rest = await everything(scope, { limit: 60, cursor: first.nextCursor as string });
    expect([...first.items.map((a) => a.assetId), ...rest]).toEqual([...ids, 'late']);
    // Offset paging still works for existing callers.
    const skipped = await store.assets.listPublished(scope, { limit: 2, skip: 128 });
    expect(skipped.items.map((a) => a.assetId)).toEqual(['p128', 'p129']);
    // Another scope sees none of it.
    expect((await store.assets.listPublished(freshScope(), {})).items).toEqual([]);
  });

  it('filter by kind, tag and the library’s folder (read live)', async () => {
    const scope = freshScope();
    await store.assets.putPublished(scope, snapshot('img', 0, { tags: ['summer'] }));
    await store.assets.putPublished(scope, snapshot('doc', 1, { contentType: 'application/pdf' }));
    await store.assets.putPublished(scope, snapshot('vid', 2, { contentType: 'video/mp4' }));
    const draft = (id: string, folderId?: string): Asset => ({
      id,
      status: 'published',
      file: { url: '', fileName: id, contentType: 'image/png' },
      title: {},
      description: {},
      metadata: { altText: {}, tags: [] },
      ...(folderId ? { folderId } : {}),
    });
    await store.assetFolders.create(scope, {
      id: 'f1',
      name: 'f1',
      path: '/f1/',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await store.assets.create(scope, draft('img', 'f1'));
    await store.assets.create(scope, draft('doc'));
    await store.assets.create(scope, draft('vid'));

    expect(await everything(scope, { filters: { kind: 'image' } })).toEqual(['img']);
    expect(await everything(scope, { filters: { kind: 'document' } })).toEqual(['doc']);
    expect(await everything(scope, { filters: { tag: 'summer' } })).toEqual(['img']);
    expect(await everything(scope, { filters: { folderId: 'f1' } })).toEqual(['img']);
    expect(await everything(scope, { filters: { folderId: null } })).toEqual(['doc', 'vid']);
    // Moving it in the library moves it in Delivery's listing, without a republish.
    await store.assets.moveToFolder(scope, ['img'], null);
    expect(await everything(scope, { filters: { folderId: 'f1' } })).toEqual([]);
  });
});

describe('rendition presets', () => {
  const preset = (name: string, over: Partial<AssetRendition> = {}): AssetRendition => ({
    name,
    width: 400,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('are kept per space, by name, and replaced whole', async () => {
    const scope = freshScope();
    await store.assetRenditions.put(
      scope,
      preset('thumb', { height: 400, fit: 'crop', format: 'webp', quality: 80 }),
    );
    await store.assetRenditions.put(scope, preset('hero'));
    expect((await store.assetRenditions.list(scope)).map((r) => r.name)).toEqual(['hero', 'thumb']);
    expect(await store.assetRenditions.get(scope, 'thumb')).toEqual(
      preset('thumb', { height: 400, fit: 'crop', format: 'webp', quality: 80 }),
    );
    // Replaced: unset fields go, the creation time stays.
    await store.assetRenditions.put(
      scope,
      preset('thumb', {
        width: 200,
        createdAt: '2027-01-01T00:00:00.000Z',
        updatedAt: '2027-01-01T00:00:00.000Z',
      }),
    );
    expect(await store.assetRenditions.get(scope, 'thumb')).toEqual(
      preset('thumb', { width: 200, updatedAt: '2027-01-01T00:00:00.000Z' }),
    );
    // Any environment of the space reads them; another space doesn't.
    expect(
      await store.assetRenditions.get({ ...scope, environmentId: 'staging' }, 'hero'),
    ).not.toBeNull();
    expect(await store.assetRenditions.list(freshScope())).toEqual([]);
    await store.assetRenditions.delete(scope, 'hero');
    expect(await store.assetRenditions.get(scope, 'hero')).toBeNull();
  });

  it('commit with the outbox event in one unit', async () => {
    const scope = freshScope();
    await expect(
      store.withTransaction(async (tx) => {
        await tx.assetRenditions.put(scope, preset('card'));
        throw new Error('abandoned');
      }),
    ).rejects.toThrow('abandoned');
    expect(await store.assetRenditions.get(scope, 'card')).toBeNull();
  });
});

describe('the 0009 backfill', () => {
  it('copies each snapshot’s version, key, kind and rights from its asset', async () => {
    const spaceId = `dl-${uid()}`;
    const asset = (id: string, kind: string, r2Key: string | null, rights: string | null) =>
      testDb
        .prepare(
          `insert into assets (space_id, environment_id, id, status, file, title, description, updated_at, kind, version, r2_key, rights)
           values (?, 'main', ?, 'published', '{}', '{}', '{}', 0, ?, 2, ?, ?)`,
        )
        .bind(spaceId, id, kind, r2Key, rights)
        .run();
    // Snapshots as the code before 0009 wrote them: none of the new columns set.
    const published = (id: string) =>
      testDb
        .prepare(
          `insert into asset_published (space_id, environment_id, asset_id, file, title, description, published_at)
           values (?, 'main', ?, '{"url":"","fileName":"f","contentType":"image/png"}', '{}', '{}', 0)`,
        )
        .bind(spaceId, id)
        .run();
    await asset('a', 'image', `${spaceId}/main/a/f`, '{"credit":"Ada"}');
    await asset('b', 'document', null, null);
    await published('a');
    await published('b');
    await published('orphan');

    const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    const m = migrations.find((x) => x.name.startsWith('0009_'));
    const updates = (m?.queries ?? []).filter((q) => /UPDATE `asset_published`/.test(q));
    expect(updates).toHaveLength(1);
    for (const q of updates) await testDb.prepare(q).run();

    const rows = await testDb
      .prepare(
        'select asset_id, version, r2_key, kind, rights from asset_published where space_id = ? order by asset_id',
      )
      .bind(spaceId)
      .all();
    expect(rows.results).toEqual([
      {
        asset_id: 'a',
        version: 2,
        r2_key: `${spaceId}/main/a/f`,
        kind: 'image',
        rights: '{"credit":"Ada"}',
      },
      { asset_id: 'b', version: 2, r2_key: null, kind: 'document', rights: null },
      // A snapshot whose asset row is gone keeps the defaults.
      { asset_id: 'orphan', version: 1, r2_key: null, kind: 'other', rights: null },
    ]);
  });
});

describe('the 0010 backfill', () => {
  it('fills only the snapshots the old code wrote after 0009, from their asset', async () => {
    const spaceId = `dl-${uid()}`;
    const asset = (id: string, kind: string, r2Key: string | null, rights: string | null) =>
      testDb
        .prepare(
          `insert into assets (space_id, environment_id, id, status, file, title, description, updated_at, kind, version, r2_key, rights)
           values (?, 'main', ?, 'published', '{}', '{}', '{}', 0, ?, 1, ?, ?)`,
        )
        .bind(spaceId, id, kind, r2Key, rights)
        .run();
    const published = (id: string, kind: string, r2Key: string | null, rights: string | null) =>
      testDb
        .prepare(
          `insert into asset_published (space_id, environment_id, asset_id, file, title, description, published_at, kind, r2_key, rights)
           values (?, 'main', ?, '{"url":"","fileName":"f","contentType":"image/png"}', '{}', '{}', 0, ?, ?, ?)`,
        )
        .bind(spaceId, id, kind, r2Key, rights)
        .run();
    // Published by the old api mid-deploy: the column defaults.
    await asset('late', 'image', `${spaceId}/main/late/f`, '{"credit":"Ada"}');
    await published('late', 'other', null, null);
    // Written by the new code: left alone, even where the asset row now differs.
    await asset('current', 'image', `${spaceId}/main/current/f`, null);
    await published('current', 'image', `${spaceId}/main/current/old`, '{"license":"cc"}');
    // A genuinely 'other' file the new code published: nothing better to copy.
    await asset('zip', 'other', `${spaceId}/main/zip/f`, null);
    await published('zip', 'other', `${spaceId}/main/zip/f`, null);
    // Its asset row is gone: keeps the defaults.
    await published('orphan', 'other', null, null);

    const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    const m = migrations.find((x) => x.name.startsWith('0010_'));
    const updates = (m?.queries ?? []).filter((q) => /UPDATE `asset_published`/.test(q));
    expect(updates).toHaveLength(1);
    for (const q of updates) await testDb.prepare(q).run();

    const rows = await testDb
      .prepare(
        'select asset_id, r2_key, kind, rights from asset_published where space_id = ? order by asset_id',
      )
      .bind(spaceId)
      .all();
    expect(rows.results).toEqual([
      {
        asset_id: 'current',
        r2_key: `${spaceId}/main/current/old`,
        kind: 'image',
        rights: '{"license":"cc"}',
      },
      {
        asset_id: 'late',
        r2_key: `${spaceId}/main/late/f`,
        kind: 'image',
        rights: '{"credit":"Ada"}',
      },
      { asset_id: 'orphan', r2_key: null, kind: 'other', rights: null },
      { asset_id: 'zip', r2_key: `${spaceId}/main/zip/f`, kind: 'other', rights: null },
    ]);
  });
});
