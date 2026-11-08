import {
  ConflictError,
  MAX_ASSET_FOLDER_DEPTH,
  NotFoundError,
  ValidationError,
} from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createAsset,
  createAssetFolder,
  createSpace,
  deleteAssetFolder,
  listAssetFolders,
  moveAssets,
  updateAssetFolder,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

describe('asset folders', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  beforeEach(async () => {
    store = new InMemoryContentStore();
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('f') };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('nests folders by materialized path, a parent listed before its children', async () => {
    const brand = await createAssetFolder(ctx, scope, { name: '  Brand  ' });
    const logos = await createAssetFolder(ctx, scope, { name: 'Logos', parentId: brand.id });
    expect(brand).toMatchObject({ name: 'Brand', path: `/${brand.id}/` });
    expect(logos).toMatchObject({ parentId: brand.id, path: `/${brand.id}/${logos.id}/` });
    expect((await listAssetFolders(ctx, scope)).map((f) => f.id)).toEqual([brand.id, logos.id]);
  });

  it('refuses a bad name, an unknown parent, and a sibling with the same name', async () => {
    await expect(createAssetFolder(ctx, scope, { name: 'a/b' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(createAssetFolder(ctx, scope, { name: ' ' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      createAssetFolder(ctx, scope, { name: 'x', parentId: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await createAssetFolder(ctx, scope, { name: 'Brand' });
    await expect(createAssetFolder(ctx, scope, { name: 'Brand' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('moves a folder with its whole subtree, and renames it', async () => {
    const a = await createAssetFolder(ctx, scope, { name: 'A' });
    const b = await createAssetFolder(ctx, scope, { name: 'B', parentId: a.id });
    const c = await createAssetFolder(ctx, scope, { name: 'C', parentId: b.id });
    const target = await createAssetFolder(ctx, scope, { name: 'Target' });

    const moved = await updateAssetFolder(ctx, scope, b.id, { parentId: target.id, name: 'B2' });
    expect(moved).toMatchObject({
      name: 'B2',
      parentId: target.id,
      path: `/${target.id}/${b.id}/`,
    });
    expect((await store.assetFolders.get(scope, c.id))?.path).toBe(
      `/${target.id}/${b.id}/${c.id}/`,
    );

    const toRoot = await updateAssetFolder(ctx, scope, b.id, { parentId: null });
    expect(toRoot.parentId).toBeUndefined();
    expect(toRoot.path).toBe(`/${b.id}/`);
    expect((await store.assetFolders.get(scope, c.id))?.path).toBe(`/${b.id}/${c.id}/`);
  });

  it('never moves a folder into itself or below itself', async () => {
    const a = await createAssetFolder(ctx, scope, { name: 'A' });
    const b = await createAssetFolder(ctx, scope, { name: 'B', parentId: a.id });
    await expect(updateAssetFolder(ctx, scope, a.id, { parentId: a.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(updateAssetFolder(ctx, scope, a.id, { parentId: b.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it(`refuses nesting deeper than ${MAX_ASSET_FOLDER_DEPTH}, counting the subtree a move takes`, async () => {
    let parentId: string | undefined;
    for (let i = 0; i < MAX_ASSET_FOLDER_DEPTH; i++) {
      parentId = (await createAssetFolder(ctx, scope, { name: `L${i}`, parentId })).id;
    }
    await expect(
      createAssetFolder(ctx, scope, { name: 'too deep', parentId }),
    ).rejects.toBeInstanceOf(ValidationError);
    const a = await createAssetFolder(ctx, scope, { name: 'Shallow' });
    await createAssetFolder(ctx, scope, { name: 'Child', parentId: a.id });
    const deep = (await listAssetFolders(ctx, scope)).find(
      (f) => f.name === `L${MAX_ASSET_FOLDER_DEPTH - 2}`,
    );
    await expect(
      updateAssetFolder(ctx, scope, a.id, { parentId: deep?.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('deletes only an empty folder', async () => {
    const blob = new FakeBlobStore();
    const a = await createAssetFolder(ctx, scope, { name: 'A' });
    const b = await createAssetFolder(ctx, scope, { name: 'B', parentId: a.id });
    await expect(deleteAssetFolder(ctx, scope, a.id)).rejects.toBeInstanceOf(ConflictError);

    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: 'x.png',
      contentType: 'image/png',
    });
    await moveAssets(ctx, scope, { ids: [asset.id], folderId: b.id });
    await expect(deleteAssetFolder(ctx, scope, b.id)).rejects.toBeInstanceOf(ConflictError);

    await moveAssets(ctx, scope, { ids: [asset.id], folderId: null });
    await deleteAssetFolder(ctx, scope, b.id);
    await deleteAssetFolder(ctx, scope, a.id);
    expect(await listAssetFolders(ctx, scope)).toEqual([]);
    await expect(deleteAssetFolder(ctx, scope, a.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses the delete when an asset is filed between the check and the commit', async () => {
    const blob = new FakeBlobStore();
    const a = await createAssetFolder(ctx, scope, { name: 'A' });
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: 'x.png',
      contentType: 'image/png',
    });
    const list = store.assets.list.bind(store.assets);
    store.assets.list = async (s, q) => {
      store.assets.list = list;
      const page = await list(s, q);
      await store.assets.moveToFolder(s, [asset.id], a.id);
      return page;
    };
    await expect(deleteAssetFolder(ctx, scope, a.id)).rejects.toBeInstanceOf(ConflictError);
    expect(await store.assetFolders.get(scope, a.id)).not.toBeNull();
  });

  it('refuses a subfolder whose parent is deleted between the check and the commit', async () => {
    const a = await createAssetFolder(ctx, scope, { name: 'A' });
    const get = store.assetFolders.get.bind(store.assetFolders);
    store.assetFolders.get = async (s, id) => {
      store.assetFolders.get = get;
      const found = await get(s, id);
      await store.assetFolders.delete(s, id);
      return found;
    };
    await expect(
      createAssetFolder(ctx, scope, { name: 'B', parentId: a.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await listAssetFolders(ctx, scope)).toEqual([]);
  });

  it('refuses an upload into a folder deleted between the check and the commit', async () => {
    const blob = new FakeBlobStore();
    const a = await createAssetFolder(ctx, scope, { name: 'A' });
    const get = store.assetFolders.get.bind(store.assetFolders);
    store.assetFolders.get = async (s, id) => {
      store.assetFolders.get = get;
      const found = await get(s, id);
      await store.assetFolders.delete(s, id);
      return found;
    };
    await expect(
      createAsset(
        ctx,
        blob,
        scope,
        { fileName: 'x.png', contentType: 'image/png' },
        { folderId: a.id },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await store.assets.list(scope, { filters: { status: 'all' } })).items).toEqual([]);
  });

  it('keeps folders per environment', async () => {
    await createAssetFolder(ctx, scope, { name: 'A' });
    expect(await listAssetFolders(ctx, { spaceId: 'shop', environmentId: 'staging' })).toEqual([]);
  });
});
