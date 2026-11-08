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
  getPublishedAsset,
  getPublishedEntry,
  publishAsset,
  publishEntry,
  SYSTEM_CALLER,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('a') };
  return { ctx, blob };
}

describe('P3b: assets', () => {
  let ctx: AppContext;
  let blob: FakeBlobStore;
  beforeEach(() => {
    ({ ctx, blob } = setup());
    return createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('creates a draft asset with a presigned upload URL, then publishes + delivers it', async () => {
    const created = await createAsset(ctx, blob, scope, {
      fileName: 'logo.png',
      contentType: 'image/png',
      title: { 'en-US': 'Logo' },
    });
    expect(created.upload.url).toContain('upload=1');
    expect(blob.uploads[0]?.contentType).toBe('image/png');
    expect(created.asset.status).toBe('draft');

    // Not deliverable until published.
    await expect(getPublishedAsset(ctx, scope, created.asset.id)).rejects.toThrow(/not.*found/i);

    await publishAsset(ctx, scope, created.asset.id);
    const delivered = await getPublishedAsset(ctx, scope, created.asset.id);
    expect(delivered.file.fileName).toBe('logo.png');
    expect(delivered.title['en-US']).toBe('Logo');
  });

  it('sanitizes a traversal file name so the object key stays inside the scope prefix', async () => {
    const created = await createAsset(ctx, blob, scope, {
      fileName: '../../../other-space/other-env/victim/logo.png',
      contentType: 'image/png',
    });
    const key = blob.uploads.at(-1)?.key ?? '';
    // Key must stay under the scoped prefix; no traversal segment may survive.
    expect(key.startsWith(`${scope.spaceId}/${scope.environmentId}/`)).toBe(true);
    expect(key).not.toContain('..');
    expect(key).not.toContain('other-space');
    expect(key.endsWith('/logo.png')).toBe(true);
    // The original name is still preserved as display metadata.
    expect(created.asset.file.fileName).toBe('../../../other-space/other-env/victim/logo.png');
  });

  it('falls back to a safe key segment when the file name is only traversal/empty', async () => {
    const created = await createAsset(ctx, blob, scope, {
      fileName: '../..',
      contentType: 'application/octet-stream',
    });
    const key = blob.uploads.at(-1)?.key ?? '';
    expect(key.startsWith(`${scope.spaceId}/${scope.environmentId}/`)).toBe(true);
    expect(key).not.toContain('..');
    expect(key.endsWith('/file')).toBe(true);
    expect(created.asset.id).toBeTruthy();
  });

  it('refuses to publish an entry linking to a nonexistent asset', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'product',
      name: 'Product',
      displayField: 'name',
      fields: [
        {
          apiId: 'name',
          name: 'Name',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'image',
          name: 'Image',
          type: 'Link',
          localized: false,
          required: false,
          position: 1,
          linkType: 'Asset',
        },
      ],
    });
    const entry = await createEntry(ctx, scope, {
      contentTypeApiId: 'product',
      fields: {
        name: { 'en-US': 'Widget' },
        image: { 'en-US': { id: 'missing-asset', linkType: 'Asset' } },
      },
    });
    await expect(publishEntry(ctx, scope, entry.entry.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it('resolves an Asset link to the embedded published asset with ?include', async () => {
    const asset = await createAsset(ctx, blob, scope, {
      fileName: 'hero.jpg',
      contentType: 'image/jpeg',
      title: { 'en-US': 'Hero' },
    });
    await publishAsset(ctx, scope, asset.asset.id);

    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'product',
      name: 'Product',
      displayField: 'name',
      fields: [
        {
          apiId: 'name',
          name: 'Name',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'image',
          name: 'Image',
          type: 'Link',
          localized: false,
          required: false,
          position: 1,
          linkType: 'Asset',
        },
      ],
    });
    const entry = await createEntry(ctx, scope, {
      contentTypeApiId: 'product',
      fields: {
        name: { 'en-US': 'Widget' },
        image: { 'en-US': { id: asset.asset.id, linkType: 'Asset' } },
      },
    });
    await publishEntry(ctx, scope, entry.entry.id);

    const resolved = await getPublishedEntry(ctx, scope, entry.entry.id, {
      locale: 'en-US',
      include: 1,
    });
    const embedded = resolved.fields.image as { id: string; file: { fileName: string } };
    expect(embedded.id).toBe(asset.asset.id);
    expect(embedded.file.fileName).toBe('hero.jpg');
  });
});
