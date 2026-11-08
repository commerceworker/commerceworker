import { ValidationError } from '@commerceworker/domain';
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
  createContentType,
  createEntry,
  createSpace,
  getAsset,
  getAssetUsage,
  getPublishedAsset,
  publishAsset,
  publishEntry,
  SYSTEM_CALLER,
  setAssetMetadata,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('a') };
  return { ctx, blob };
}

async function newAsset(ctx: AppContext, blob: FakeBlobStore) {
  const { asset } = await createAsset(ctx, blob, scope, {
    fileName: 'logo.png',
    contentType: 'image/png',
  });
  return asset.id;
}

describe('asset metadata', () => {
  let ctx: AppContext;
  let blob: FakeBlobStore;
  beforeEach(() => {
    ({ ctx, blob } = setup());
    return createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('starts empty and accepts alt text, tags, and a focal point', async () => {
    const id = await newAsset(ctx, blob);
    expect((await getAsset(ctx, scope, id)).metadata).toEqual({ altText: {}, tags: [] });

    const updated = await setAssetMetadata(ctx, scope, id, {
      altText: { 'en-US': 'Company logo' },
      tags: ['tag-brand'],
      focalPoint: { x: 0.25, y: 0.75 },
    });
    expect(updated.metadata.altText).toEqual({ 'en-US': 'Company logo' });
    expect(updated.metadata.tags).toEqual(['tag-brand']);
    expect(updated.metadata.focalPoint).toEqual({ x: 0.25, y: 0.75 });
  });

  it('applies partial patches without clobbering omitted fields', async () => {
    const id = await newAsset(ctx, blob);
    await setAssetMetadata(ctx, scope, id, { altText: { 'en-US': 'Logo' }, tags: ['tag-a'] });
    const after = await setAssetMetadata(ctx, scope, id, { focalPoint: { x: 0.5, y: 0.5 } });
    expect(after.metadata.altText).toEqual({ 'en-US': 'Logo' });
    expect(after.metadata.tags).toEqual(['tag-a']);
    expect(after.metadata.focalPoint).toEqual({ x: 0.5, y: 0.5 });
  });

  it('rejects a focal point outside the unit square', async () => {
    const id = await newAsset(ctx, blob);
    await expect(
      setAssetMetadata(ctx, scope, id, { focalPoint: { x: 1.5, y: 0 } }),
    ).rejects.toThrow(ValidationError);
  });

  it('carries metadata into the published snapshot', async () => {
    const id = await newAsset(ctx, blob);
    await setAssetMetadata(ctx, scope, id, { altText: { 'en-US': 'Logo' } });
    await publishAsset(ctx, scope, id);
    const snapshot = await getPublishedAsset(ctx, scope, id);
    expect(snapshot.metadata.altText).toEqual({ 'en-US': 'Logo' });
  });
});

describe('asset usage', () => {
  let ctx: AppContext;
  let blob: FakeBlobStore;
  beforeEach(() => {
    ({ ctx, blob } = setup());
    return createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('lists entries that reference an asset once they are published', async () => {
    const assetId = await newAsset(ctx, blob);
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'hero',
          name: 'Hero',
          type: 'Link',
          localized: false,
          required: false,
          position: 1,
          linkType: 'Asset',
        },
      ],
    });

    expect(await getAssetUsage(ctx, scope, assetId)).toEqual([]);

    const post = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'Hello' },
        hero: { 'en-US': { id: assetId, linkType: 'Asset' } },
      },
    });
    await publishEntry(ctx, scope, post.entry.id);

    const usage = await getAssetUsage(ctx, scope, assetId);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.fromEntryId).toBe(post.entry.id);
    expect(usage[0]?.toType).toBe('Asset');
  });
});
