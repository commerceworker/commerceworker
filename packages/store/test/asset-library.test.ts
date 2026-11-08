import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Asset, AssetFolder } from '@commerceworker/domain';
import { ConflictError, ValidationError } from '@commerceworker/domain';
import { type AssetPage, TransactionConflictError } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * The asset library on D1: filtered, keyset-paged listings, folders as materialized paths, moves
 * that pass ids as one JSON parameter, the guards that refuse a delete at commit, and the 0007
 * backfill of the new columns from the `file` JSON. The file shares one database: each test makes
 * its own space.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const freshScope = () => ({ spaceId: `dam-${uid()}`, environmentId: 'main' });

const asset = (over: Partial<Asset> & { contentType?: string; size?: number } = {}): Asset => {
  const { contentType = 'image/png', size, ...rest } = over;
  const id = rest.id ?? uid();
  return {
    id,
    status: 'draft',
    file: {
      url: `/media/s/main/${id}/f`,
      fileName: 'f',
      contentType,
      ...(size !== undefined ? { size } : {}),
    },
    title: {},
    description: {},
    metadata: { altText: {}, tags: [] },
    ...rest,
  };
};

const folder = (id: string, path: string, name = id, parentId?: string): AssetFolder => ({
  id,
  name,
  ...(parentId ? { parentId } : {}),
  path,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

async function everything(
  scope: { spaceId: string; environmentId: string },
  query: Parameters<typeof store.assets.list>[1],
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page: AssetPage = await store.assets.list(scope, {
      ...query,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...page.items.map((a) => a.id));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

describe('asset listing on D1', () => {
  it('filters by kind, mime family, tag, folder and status', async () => {
    const scope = freshScope();
    const png = asset({ contentType: 'image/png', metadata: { altText: {}, tags: ['t-hero'] } });
    const jpg = asset({ contentType: 'Image/JPEG; q=1', folderId: 'f1' });
    const pdf = asset({ contentType: 'application/pdf', status: 'published' });
    const gone = asset({ contentType: 'image/png', status: 'archived' });
    await store.assetFolders.create(scope, folder('f1', '/f1/'));
    for (const a of [png, jpg, pdf, gone]) await store.assets.create(scope, a);

    const ids = async (filters: Parameters<typeof store.assets.list>[1]['filters']) =>
      (await everything(scope, { filters })).sort();

    expect(await ids({ kind: 'image' })).toEqual([png.id, jpg.id].sort());
    expect(await ids({ kind: 'document' })).toEqual([pdf.id]);
    expect(await ids({ mime: 'image/*' })).toEqual([png.id, jpg.id].sort());
    expect(await ids({ mime: 'image/jpeg' })).toEqual([jpg.id]);
    expect(await ids({ tag: 't-hero' })).toEqual([png.id]);
    expect(await ids({ folderId: 'f1' })).toEqual([jpg.id]);
    expect(await ids({ folderId: null })).toEqual([png.id, pdf.id].sort());
    expect(await ids({ status: 'published' })).toEqual([pdf.id]);
    expect(await ids({ status: 'archived' })).toEqual([gone.id]);
    expect(await ids({ status: 'all' })).toHaveLength(4);
    // Another environment of the same space sees none of them.
    expect(await everything({ ...scope, environmentId: 'other' }, {})).toEqual([]);
  });

  it('pages a large library with the cursor: every asset once, in order', async () => {
    const scope = freshScope();
    const sizes = Array.from({ length: 130 }, (_, i) => (i % 13 === 0 ? undefined : i % 7));
    const created = sizes.map((size) => asset({ size }));
    for (const a of created) await store.assets.create(scope, a);

    const bySize = await everything(scope, {
      limit: 40,
      sort: { field: 'size', direction: 'asc' },
    });
    expect(bySize).toHaveLength(130);
    expect(new Set(bySize).size).toBe(130);
    const sizeOf = new Map(created.map((a) => [a.id, a.file.size ?? -1]));
    const seen = bySize.map((id) => sizeOf.get(id) ?? 0);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));

    const byUpdated = await everything(scope, { limit: 33 });
    expect(new Set(byUpdated).size).toBe(130);
  });

  it('refuses a cursor it did not issue', async () => {
    await expect(
      store.assets.list(freshScope(), { cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('round-trips the DAM fields and derives kind and mime on every write', async () => {
    const scope = freshScope();
    const a = asset({
      contentType: 'video/MP4',
      version: 3,
      r2Key: `${scope.spaceId}/main/x/f`,
      contentHash: 'abc',
      createdAt: '2026-02-01T00:00:00.000Z',
      createdBy: 'ana@example.com',
      rights: { license: 'CC-BY', credit: 'Ana', expiresAt: '2027-01-01T00:00:00.000Z' },
    });
    await store.assets.create(scope, a);
    expect(await store.assets.get(scope, a.id)).toEqual(a);
    const row = await testDb
      .prepare('select kind, mime from assets where space_id = ? and id = ?')
      .bind(scope.spaceId, a.id)
      .first<{ kind: string; mime: string }>();
    expect(row).toEqual({ kind: 'video', mime: 'video/mp4' });
  });
});

describe('moving assets on D1', () => {
  it('moves more than 100 assets in one statement (ids as one JSON parameter)', async () => {
    const scope = freshScope();
    await store.assetFolders.create(scope, folder('f-big', '/f-big/'));
    const many = Array.from({ length: 150 }, () => asset());
    for (const a of many) await store.assets.create(scope, a);

    await store.withTransaction((tx) =>
      tx.assets.moveToFolder(
        scope,
        many.map((a) => a.id),
        'f-big',
      ),
    );
    expect(await everything(scope, { filters: { folderId: 'f-big' } })).toHaveLength(150);

    await store.assets.moveToFolder(
      scope,
      many.map((a) => a.id),
      null,
    );
    expect(await everything(scope, { filters: { folderId: 'f-big' } })).toEqual([]);
  });

  it('aborts a move into a folder that is gone by commit', async () => {
    const scope = freshScope();
    const a = asset();
    await store.assets.create(scope, a);
    await expect(
      store.withTransaction((tx) => tx.assets.moveToFolder(scope, [a.id], 'missing')),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect((await store.assets.get(scope, a.id))?.folderId).toBeUndefined();
  });
});

describe('deleting an asset on D1', () => {
  it('is aborted at commit while an entry links to it', async () => {
    const scope = freshScope();
    const a = asset({ status: 'published' });
    await store.assets.create(scope, a);
    await store.references.replaceForEntry(scope, 'e1', [
      { fromEntryId: 'e1', fromField: 'hero', toId: a.id, toType: 'Asset' },
    ]);
    await expect(
      store.withTransaction((tx) => tx.assets.delete(scope, a.id)),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(await store.assets.get(scope, a.id)).not.toBeNull();

    await store.references.replaceForEntry(scope, 'e1', []);
    await store.assets.putPublished(scope, {
      assetId: a.id,
      file: a.file,
      title: {},
      description: {},
      metadata: a.metadata,
      publishedAt: '2026-01-01T00:00:00.000Z',
    });
    await store.withTransaction((tx) => tx.assets.delete(scope, a.id));
    expect(await store.assets.get(scope, a.id)).toBeNull();
    expect(await store.assets.getPublished(scope, a.id)).toBeNull();
  });

  it('a link in another environment does not hold it', async () => {
    const scope = freshScope();
    const a = asset();
    await store.assets.create(scope, a);
    await store.references.replaceForEntry({ ...scope, environmentId: 'other' }, 'e1', [
      { fromEntryId: 'e1', fromField: 'hero', toId: a.id, toType: 'Asset' },
    ]);
    await store.assets.delete(scope, a.id);
    expect(await store.assets.get(scope, a.id)).toBeNull();
  });
});

describe('asset folders on D1', () => {
  it('rewrites a whole subtree’s paths when a folder moves', async () => {
    const scope = freshScope();
    await store.assetFolders.create(scope, folder('a', '/a/'));
    await store.assetFolders.create(scope, folder('b', '/a/b/', 'b', 'a'));
    await store.assetFolders.create(scope, folder('c', '/a/b/c/', 'c', 'b'));
    await store.assetFolders.create(scope, folder('t', '/t/'));
    // A folder whose path merely shares characters with the moved prefix stays put.
    await store.assetFolders.create(scope, folder('ab', '/ab/'));

    await store.assetFolders.save(scope, { ...folder('b', '/t/b/', 'B', 't') }, '/a/b/');

    const paths = Object.fromEntries(
      (await store.assetFolders.list(scope)).map((f) => [f.id, f.path]),
    );
    expect(paths).toEqual({ a: '/a/', ab: '/ab/', b: '/t/b/', c: '/t/b/c/', t: '/t/' });
    expect((await store.assetFolders.get(scope, 'b'))?.name).toBe('B');
    expect((await store.assetFolders.get(scope, 'b'))?.parentId).toBe('t');
  });

  it('aborts a subfolder, or an asset filed in a folder, when the folder is gone by commit', async () => {
    const scope = freshScope();
    await expect(
      store.withTransaction((tx) =>
        tx.assetFolders.create(scope, folder('c', '/gone/c/', 'c', 'gone')),
      ),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    await expect(
      store.assetFolders.create(scope, folder('c', '/gone/c/', 'c', 'gone')),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    const a = asset({ folderId: 'gone' });
    await expect(store.withTransaction((tx) => tx.assets.create(scope, a))).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
    await expect(store.assets.create(scope, a)).rejects.toBeInstanceOf(TransactionConflictError);
    expect(await store.assetFolders.list(scope)).toEqual([]);
    expect(await store.assets.get(scope, a.id)).toBeNull();

    await store.assetFolders.create(scope, folder('here', '/here/'));
    await store.assetFolders.create(scope, folder('k2', '/here/k2/', 'k2', 'here'));
    await store.assets.create(scope, asset({ id: a.id, folderId: 'here' }));
    expect((await store.assets.get(scope, a.id))?.folderId).toBe('here');
  });

  it('keeps sibling names unique, at the root too', async () => {
    const scope = freshScope();
    await store.assetFolders.create(scope, folder('x1', '/x1/', 'Brand'));
    await expect(
      store.assetFolders.create(scope, folder('x2', '/x2/', 'Brand')),
    ).rejects.toBeInstanceOf(ConflictError);
    await store.assetFolders.create(scope, folder('x3', '/x1/x3/', 'Brand', 'x1'));
  });

  it('refuses at commit to delete a folder with a subfolder or an asset in it', async () => {
    const scope = freshScope();
    await store.assetFolders.create(scope, folder('p', '/p/'));
    await store.assetFolders.create(scope, folder('k', '/p/k/', 'k', 'p'));
    await expect(
      store.withTransaction((tx) => tx.assetFolders.delete(scope, 'p')),
    ).rejects.toBeInstanceOf(TransactionConflictError);

    const a = asset({ folderId: 'k' });
    await store.assets.create(scope, a);
    await expect(store.assetFolders.delete(scope, 'k')).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
    await store.assets.moveToFolder(scope, [a.id], null);
    await store.assetFolders.delete(scope, 'k');
    await store.assetFolders.delete(scope, 'p');
    expect(await store.assetFolders.list(scope)).toEqual([]);
  });
});

describe('the 0007 backfill', () => {
  it('fills the new columns of rows the older code wrote, from their file JSON', async () => {
    const spaceId = `dam-${uid()}`;
    const insert = (id: string, file: Record<string, unknown>) =>
      testDb
        .prepare(
          `insert into assets (space_id, environment_id, id, status, file, title, description, updated_at)
           values (?, 'main', ?, 'draft', ?, '{}', '{}', 1767225600000)`,
        )
        .bind(spaceId, id, JSON.stringify(file))
        .run();
    await insert('img', {
      url: `https://api.example.com/media/${spaceId}/main/img/logo.png?sig=abc`,
      fileName: 'logo.png',
      contentType: 'Image/PNG; charset=binary',
      size: 1234,
      width: 64,
      height: 32,
    });
    await insert('doc', {
      url: `/media/${spaceId}/main/doc/brief.pdf?sig=x`,
      fileName: 'brief.pdf',
      contentType: 'application/pdf',
    });
    await insert('enc', {
      url: `/media/${spaceId}/main/enc/my%20file.png?sig=x`,
      fileName: 'my file.png',
      contentType: 'image/png',
    });
    await insert('vid', {
      url: 'https://stream.example/v',
      fileName: 'v.mp4',
      contentType: 'video/mp4',
      video: { provider: 'stream', videoId: 'v1', status: 'ready' },
    });

    // The migration's backfill statements, run again over these rows.
    const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    const dam = migrations.find((m) => m.name.startsWith('0007_'));
    const updates = (dam?.queries ?? []).filter((q) => /UPDATE `assets`/.test(q));
    expect(updates.length).toBeGreaterThan(0);
    for (const q of updates) await testDb.prepare(q).run();

    const rows = await testDb
      .prepare(
        `select id, kind, mime, size, width, height, r2_key, created_at, version
           from assets where space_id = ? order by id`,
      )
      .bind(spaceId)
      .all();
    expect(rows.results).toEqual([
      {
        id: 'doc',
        kind: 'document',
        mime: 'application/pdf',
        size: null,
        width: null,
        height: null,
        r2_key: `${spaceId}/main/doc/brief.pdf`,
        created_at: 1767225600000,
        version: 1,
      },
      {
        id: 'enc',
        kind: 'image',
        mime: 'image/png',
        size: null,
        width: null,
        height: null,
        // Percent-encoded: left for the code's fallback rather than stored wrong.
        r2_key: null,
        created_at: 1767225600000,
        version: 1,
      },
      {
        id: 'img',
        kind: 'image',
        mime: 'image/png',
        size: 1234,
        width: 64,
        height: 32,
        r2_key: `${spaceId}/main/img/logo.png`,
        created_at: 1767225600000,
        version: 1,
      },
      {
        id: 'vid',
        kind: 'video',
        mime: 'video/mp4',
        size: null,
        width: null,
        height: null,
        r2_key: null,
        created_at: 1767225600000,
        version: 1,
      },
    ]);
    const read = await store.assets.get({ spaceId, environmentId: 'main' }, 'img');
    expect(read).toMatchObject({ version: 1, r2Key: `${spaceId}/main/img/logo.png` });
    expect(read?.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
