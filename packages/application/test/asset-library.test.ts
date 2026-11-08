import { NotFoundError, ValidationError } from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  allAssets,
  archiveAsset,
  createAsset,
  createAssetFolder,
  createSpace,
  deleteAssetFolder,
  listAssets,
  MAX_ASSET_MOVE,
  moveAssets,
  publishAsset,
  setAssetMetadata,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('a') };
  return { ctx, store, blob };
}

describe('the asset library listing', () => {
  let h: ReturnType<typeof setup>;
  const add = async (fileName: string, contentType: string, s = scope) =>
    (
      await createAsset(
        h.ctx,
        h.blob,
        s,
        { fileName, contentType },
        { createdBy: 'ana@example.com' },
      )
    ).asset;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('records who created an asset, when, and where its bytes live', async () => {
    const asset = await add('logo.png', 'image/png');
    expect(asset).toMatchObject({
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'ana@example.com',
      r2Key: `shop/main/${asset.id}/logo.png`,
    });
  });

  it('filters by kind, content type family, tag and status', async () => {
    const png = await add('a.png', 'image/png');
    const jpg = await add('b.jpg', 'image/jpeg');
    const pdf = await add('c.pdf', 'application/pdf');
    await add('d.mp3', 'audio/mpeg');
    await setAssetMetadata(h.ctx, scope, jpg.id, { tags: ['tag-hero'] });
    await publishAsset(h.ctx, scope, png.id);

    const ids = async (filters: Parameters<typeof listAssets>[2]) =>
      (await listAssets(h.ctx, scope, filters)).items.map((a) => a.id).sort();

    expect(await ids({ filters: { kind: 'image' } })).toEqual([png.id, jpg.id].sort());
    expect(await ids({ filters: { kind: 'document' } })).toEqual([pdf.id]);
    expect(await ids({ filters: { mime: 'image/*' } })).toEqual([png.id, jpg.id].sort());
    expect(await ids({ filters: { mime: 'IMAGE/PNG' } })).toEqual([png.id]);
    expect(await ids({ filters: { tag: 'tag-hero' } })).toEqual([jpg.id]);
    expect(await ids({ filters: { status: 'published' } })).toEqual([png.id]);
  });

  it('hides archived assets unless asked for them', async () => {
    const kept = await add('a.png', 'image/png');
    const gone = await add('b.png', 'image/png');
    await archiveAsset(h.ctx, scope, gone.id);

    expect((await listAssets(h.ctx, scope)).items.map((a) => a.id)).toEqual([kept.id]);
    expect(
      (await listAssets(h.ctx, scope, { filters: { status: 'archived' } })).items.map((a) => a.id),
    ).toEqual([gone.id]);
    expect((await allAssets(h.ctx, scope)).map((a) => a.id).sort()).toEqual(
      [kept.id, gone.id].sort(),
    );
  });

  it('pages with a cursor, every asset exactly once, in the requested order', async () => {
    const created: string[] = [];
    for (let i = 0; i < 7; i++) created.push((await add(`f${i}.png`, 'image/png')).id);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listAssets(h.ctx, scope, { limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((a) => a.id));
      cursor = page.nextCursor;
    } while (cursor);
    // Newest change first by default.
    expect(seen).toEqual([...created].reverse());

    const asc = await listAssets(h.ctx, scope, {
      limit: 10,
      sort: { field: 'updatedAt', direction: 'asc' },
    });
    expect(asc.items.map((a) => a.id)).toEqual(created);
    expect(asc.nextCursor).toBeUndefined();
  });

  it('keeps one environment’s assets out of another’s listing', async () => {
    await add('a.png', 'image/png');
    const other = { spaceId: 'shop', environmentId: 'staging' };
    expect((await listAssets(h.ctx, other)).items).toEqual([]);
  });

  it('moves assets into a folder and back to the root', async () => {
    const folder = await createAssetFolder(h.ctx, scope, { name: 'Campaigns' });
    const a = await add('a.png', 'image/png');
    const b = await add('b.png', 'image/png');
    const c = await add('c.png', 'image/png');

    expect(
      await moveAssets(h.ctx, scope, { ids: [a.id, b.id, 'missing'], folderId: folder.id }),
    ).toEqual({ moved: 2 });
    const inFolder = await listAssets(h.ctx, scope, { filters: { folderId: folder.id } });
    expect(inFolder.items.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    const atRoot = await listAssets(h.ctx, scope, { filters: { folderId: null } });
    expect(atRoot.items.map((x) => x.id)).toEqual([c.id]);

    await moveAssets(h.ctx, scope, { ids: [a.id], folderId: null });
    expect((await listAssets(h.ctx, scope, { filters: { folderId: null } })).items).toHaveLength(2);
  });

  it('refuses a move into a folder that does not exist, and an empty or oversized move', async () => {
    const a = await add('a.png', 'image/png');
    await expect(
      moveAssets(h.ctx, scope, { ids: [a.id], folderId: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(moveAssets(h.ctx, scope, { ids: [], folderId: null })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const many = Array.from({ length: MAX_ASSET_MOVE + 1 }, (_, i) => `id-${i}`);
    await expect(moveAssets(h.ctx, scope, { ids: many, folderId: null })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('reports a folder deleted between the check and the commit as not found', async () => {
    const folder = await createAssetFolder(h.ctx, scope, { name: 'Brief' });
    const a = await add('a.png', 'image/png');
    // The folder goes after the use-case read it.
    const get = h.store.assetFolders.get.bind(h.store.assetFolders);
    h.store.assetFolders.get = async (s, id) => {
      h.store.assetFolders.get = get;
      const found = await get(s, id);
      await deleteAssetFolder(h.ctx, s, id);
      return found;
    };
    await expect(
      moveAssets(h.ctx, scope, { ids: [a.id], folderId: folder.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await h.ctx.store.assets.get(scope, a.id))?.folderId).toBeUndefined();
  });

  it('creates an asset straight into a folder, and refuses an unknown one', async () => {
    const folder = await createAssetFolder(h.ctx, scope, { name: 'Logos' });
    const { asset } = await createAsset(
      h.ctx,
      h.blob,
      scope,
      { fileName: 'a.png', contentType: 'image/png' },
      { folderId: folder.id },
    );
    expect(asset.folderId).toBe(folder.id);
    await expect(
      createAsset(
        h.ctx,
        h.blob,
        scope,
        { fileName: 'b.png', contentType: 'image/png' },
        {
          folderId: 'nope',
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
