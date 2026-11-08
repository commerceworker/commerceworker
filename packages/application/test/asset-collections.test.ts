import {
  ConflictError,
  MAX_COLLECTION_ITEMS,
  NotFoundError,
  ValidationError,
} from '@commerceworker/domain';
import {
  FakeBlobStore,
  FakeMediaPathSigner,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addToAssetCollection,
  archiveAsset,
  cloneEnvironment,
  createAsset,
  createAssetCollection,
  createEnvironment,
  createSpace,
  deleteAsset,
  deleteAssetCollection,
  exportSnapshot,
  getAssetCollection,
  getDeliveredCollection,
  importSnapshot,
  listAssetCollectionItems,
  listAssetCollections,
  publishAsset,
  removeFromAssetCollection,
  reorderAssetCollection,
  updateAssetCollection,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

describe('asset collections', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  let blob: FakeBlobStore;
  const upload = async (fileName: string, s = scope) =>
    (await createAsset(ctx, blob, s, { fileName, contentType: 'image/png' })).asset;
  const ids = async (id: string, s = scope) =>
    (await listAssetCollectionItems(ctx, s, id, { filters: { status: 'all' } })).items.map(
      (a) => a.file.fileName,
    );

  beforeEach(async () => {
    store = new InMemoryContentStore();
    blob = new FakeBlobStore();
    ctx = {
      store,
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('c'),
      mediaPublicUrl: 'https://media.test',
      mediaPaths: new FakeMediaPathSigner(),
    };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('creates, renames, lists by name and deletes, announcing each change', async () => {
    const b = await createAssetCollection(ctx, scope, { name: ' Spring ', description: 'Look' });
    const a = await createAssetCollection(ctx, scope, { name: 'Autumn' });
    expect(b).toMatchObject({ name: 'Spring', description: 'Look', itemCount: 0 });
    expect((await listAssetCollections(ctx, scope)).items.map((c) => c.name)).toEqual([
      'Autumn',
      'Spring',
    ]);
    const renamed = await updateAssetCollection(ctx, scope, b.id, {
      name: 'Summer',
      description: '',
    });
    expect(renamed.name).toBe('Summer');
    expect(renamed.description).toBeUndefined();
    await deleteAssetCollection(ctx, scope, a.id);
    await expect(getAssetCollection(ctx, scope, a.id)).rejects.toBeInstanceOf(NotFoundError);
    const changed = store.allEvents().filter((e) => e.type === 'asset_collection.changed');
    expect(changed).toHaveLength(4);
  });

  it('refuses a bad name or a description past its limit', async () => {
    await expect(createAssetCollection(ctx, scope, { name: '  ' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      createAssetCollection(ctx, scope, { name: 'x', description: 'd'.repeat(1001) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('adds in the order given after the last member, skipping members and unknown ids', async () => {
    const [one, two, three] = [await upload('1.png'), await upload('2.png'), await upload('3.png')];
    const c = await createAssetCollection(ctx, scope, { name: 'Picks' });
    expect(await addToAssetCollection(ctx, scope, c.id, [two.id, one.id])).toEqual({
      added: 2,
      skipped: [],
    });
    expect(await addToAssetCollection(ctx, scope, c.id, [one.id, three.id, 'ghost'])).toEqual({
      added: 1,
      skipped: ['ghost'],
    });
    expect(await ids(c.id)).toEqual(['2.png', '1.png', '3.png']);
    expect((await getAssetCollection(ctx, scope, c.id)).itemCount).toBe(3);
  });

  it('puts an asset in many collections (unlike a folder)', async () => {
    const asset = await upload('a.png');
    const x = await createAssetCollection(ctx, scope, { name: 'X' });
    const y = await createAssetCollection(ctx, scope, { name: 'Y' });
    await addToAssetCollection(ctx, scope, x.id, [asset.id]);
    await addToAssetCollection(ctx, scope, y.id, [asset.id]);
    expect(await store.assetCollections.collectionsOf(scope, asset.id, 10)).toEqual([x.id, y.id]);
  });

  it('reorders: named members first, the rest after in the order they had', async () => {
    const assets = await Promise.all(['a', 'b', 'c', 'd'].map((n) => upload(`${n}.png`)));
    const c = await createAssetCollection(ctx, scope, { name: 'Order' });
    await addToAssetCollection(
      ctx,
      scope,
      c.id,
      assets.map((a) => a.id),
    );
    await reorderAssetCollection(ctx, scope, c.id, [assets[3]?.id ?? '', assets[1]?.id ?? '']);
    expect(await ids(c.id)).toEqual(['d.png', 'b.png', 'a.png', 'c.png']);
    // Again, with an id that isn't a member: ignored.
    await reorderAssetCollection(ctx, scope, c.id, [assets[2]?.id ?? '', 'ghost']);
    expect(await ids(c.id)).toEqual(['c.png', 'd.png', 'b.png', 'a.png']);
  });

  it('removes members without touching the library', async () => {
    const [one, two] = [await upload('1.png'), await upload('2.png')];
    const c = await createAssetCollection(ctx, scope, { name: 'R' });
    await addToAssetCollection(ctx, scope, c.id, [one.id, two.id]);
    expect(await removeFromAssetCollection(ctx, scope, c.id, [one.id, 'ghost'])).toEqual({
      removed: 1,
    });
    expect(await ids(c.id)).toEqual(['2.png']);
    expect(await store.assets.get(scope, one.id)).not.toBeNull();
  });

  it('refuses an add past the cap whole, and one into a collection deleted meanwhile', async () => {
    const c = await createAssetCollection(ctx, scope, { name: 'Full' });
    const many = Array.from({ length: MAX_COLLECTION_ITEMS }, (_, i) => `m${i}`);
    // Members whose assets exist, written as an import does.
    for (const id of many) {
      await store.assets.create(scope, {
        id,
        status: 'draft',
        file: { url: '', fileName: `${id}.png`, contentType: 'image/png' },
        title: {},
        description: {},
        metadata: { altText: {}, tags: [] },
      });
    }
    await store.assetCollections.restore(scope, { ...c, itemCount: 0 }, many);
    const extra = await upload('extra.png');
    await expect(addToAssetCollection(ctx, scope, c.id, [extra.id])).rejects.toBeInstanceOf(
      ConflictError,
    );
    // The store's guard, when the use-case's check passed but the collection went first.
    const gone = await createAssetCollection(ctx, scope, { name: 'Gone' });
    // Deleted after the use-case read it, before its unit committed: the store's guard refuses.
    const original = store.withTransaction.bind(store);
    store.withTransaction = async (fn) => {
      await store.assetCollections.delete(scope, gone.id);
      return original(fn);
    };
    await expect(addToAssetCollection(ctx, scope, gone.id, [extra.id])).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('reports a collection deleted before an update or reorder commits as not found', async () => {
    const c = await createAssetCollection(ctx, scope, { name: 'Gone soon' });
    const original = store.withTransaction.bind(store);
    store.withTransaction = async (fn) => {
      await store.assetCollections.delete(scope, c.id);
      return original(fn);
    };
    await expect(updateAssetCollection(ctx, scope, c.id, { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    store.withTransaction = original;
    const d = await createAssetCollection(ctx, scope, { name: 'Order' });
    store.withTransaction = async (fn) => {
      await store.assetCollections.delete(scope, d.id);
      return original(fn);
    };
    await expect(reorderAssetCollection(ctx, scope, d.id, ['a'])).rejects.toBeInstanceOf(
      NotFoundError,
    );
    store.withTransaction = original;
    expect(store.allEvents().filter((e) => e.type === 'asset_collection.changed')).toHaveLength(2);
  });

  it('keeps every collection in its own environment: another scope sees nothing of it', async () => {
    await createEnvironment(ctx, 'shop', 'staging');
    const staging = { spaceId: 'shop', environmentId: 'staging' };
    const local = await upload('here.png');
    const elsewhere = await upload('there.png', staging);
    const c = await createAssetCollection(ctx, scope, { name: 'Mine' });
    // An asset of another environment never becomes a member.
    expect(await addToAssetCollection(ctx, scope, c.id, [local.id, elsewhere.id])).toEqual({
      added: 1,
      skipped: [elsewhere.id],
    });
    await expect(getAssetCollection(ctx, staging, c.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listAssetCollections(ctx, staging)).items).toEqual([]);
    await expect(addToAssetCollection(ctx, staging, c.id, [elsewhere.id])).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('takes a deleted asset out of every collection, announcing each', async () => {
    const asset = await upload('gone.png');
    const x = await createAssetCollection(ctx, scope, { name: 'X' });
    const y = await createAssetCollection(ctx, scope, { name: 'Y' });
    await addToAssetCollection(ctx, scope, x.id, [asset.id]);
    await addToAssetCollection(ctx, scope, y.id, [asset.id]);
    const before = store.allEvents().length;
    await archiveAsset(ctx, scope, asset.id);
    await deleteAsset(ctx, scope, asset.id);
    expect((await getAssetCollection(ctx, scope, x.id)).itemCount).toBe(0);
    expect(await store.assetCollections.collectionsOf(scope, asset.id, 10)).toEqual([]);
    const announced = store
      .allEvents()
      .slice(before)
      .filter((e) => e.type === 'asset_collection.changed')
      .map((e) => (e as { collectionId: string }).collectionId)
      .sort();
    expect(announced).toEqual([x.id, y.id].sort());
  });

  it('delivers only the published members, in order, in the delivered shape', async () => {
    const [draft, live, archived] = [
      await upload('draft.png'),
      await upload('live.png'),
      await upload('arch.png'),
    ];
    await publishAsset(ctx, scope, live.id);
    await publishAsset(ctx, scope, archived.id);
    await archiveAsset(ctx, scope, archived.id);
    const c = await createAssetCollection(ctx, scope, { name: 'Public', description: 'Shown' });
    await addToAssetCollection(ctx, scope, c.id, [draft.id, archived.id, live.id]);
    const delivered = await getDeliveredCollection(ctx, scope, c.id);
    expect(delivered).toMatchObject({ id: c.id, name: 'Public', description: 'Shown' });
    expect(delivered.items.map((a) => a.id)).toEqual([live.id]);
    expect(delivered.items[0]?.url).toMatch(/^https:\/\/media\.test\//);
  });

  it('pages a collection with a cursor', async () => {
    const assets = await Promise.all(['a', 'b', 'c'].map((n) => upload(`${n}.png`)));
    const c = await createAssetCollection(ctx, scope, { name: 'Pages' });
    await addToAssetCollection(
      ctx,
      scope,
      c.id,
      assets.map((a) => a.id),
    );
    const first = await listAssetCollectionItems(ctx, scope, c.id, { limit: 2 });
    expect(first.items.map((a) => a.file.fileName)).toEqual(['a.png', 'b.png']);
    const second = await listAssetCollectionItems(ctx, scope, c.id, {
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.items.map((a) => a.file.fileName)).toEqual(['c.png']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('travels through export, import and clone, keeping members whose asset arrives', async () => {
    const [one, two] = [await upload('1.png'), await upload('2.png')];
    const c = await createAssetCollection(ctx, scope, { name: 'Travel' });
    await addToAssetCollection(ctx, scope, c.id, [two.id, one.id]);
    const snapshot = await exportSnapshot(ctx, scope);
    expect(snapshot.assetCollections).toEqual([
      {
        collection: expect.objectContaining({ id: c.id, name: 'Travel' }),
        assetIds: [two.id, one.id],
      },
    ]);

    // An import whose snapshot lost one asset keeps the member it can.
    await createEnvironment(ctx, 'shop', 'restore');
    const restore = { spaceId: 'shop', environmentId: 'restore' };
    await importSnapshot(ctx, restore, {
      ...snapshot,
      assets: snapshot.assets.filter((a) => a.id !== one.id),
    });
    expect((await getAssetCollection(ctx, restore, c.id)).itemCount).toBe(1);
    expect(await ids(c.id, restore)).toEqual(['2.png']);

    await createEnvironment(ctx, 'shop', 'copy');
    const copy = { spaceId: 'shop', environmentId: 'copy' };
    await cloneEnvironment(ctx, scope, copy);
    expect(await ids(c.id, copy)).toEqual(['2.png', '1.png']);
  });
});
