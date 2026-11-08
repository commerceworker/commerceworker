import {
  type Asset,
  type DomainEvent,
  NotFoundError,
  ValidationError,
} from '@commerceworker/domain';
import {
  FakeBlobStore,
  FakeImageTransformer,
  FakeMediaPathSigner,
  FakeVideoHost,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  archiveAsset,
  assetGateEntry,
  assetObjectKey,
  assetTransformTarget,
  createAsset,
  createAssetRendition,
  createContentType,
  createEntry,
  createSpace,
  createVideoAsset,
  getAsset,
  getDeliveredAsset,
  getPreviewAsset,
  getPublishedAsset,
  getPublishedEntry,
  listDeliveredAssets,
  listPreviewAssets,
  publishAsset,
  publishContentType,
  publishEntry,
  READ_URL_TTL_SECONDS,
  refreshVideoAsset,
  SYSTEM_CALLER,
  setAssetMetadata,
  withReadUrl,
} from '../src/index';

const MEDIA = 'https://media.shop.test';
const scope = { spaceId: 'shop', environmentId: 'main' };
const paths = new FakeMediaPathSigner();
/** Where a published asset's files live on the media origin, at a version. */
const mediaBase = (id: string, version = 1) =>
  `${MEDIA}/shop/main/${id}/v${version}/${paths.token(scope, id, version)}`;

function setup(opts: { media?: boolean } = {}) {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const images = new FakeImageTransformer();
  const video = new FakeVideoHost();
  const ctx: AppContext = {
    store,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('d'),
    images,
    video,
    ...(opts.media === false ? {} : { mediaPublicUrl: MEDIA, mediaPaths: paths }),
  };
  return { ctx, store, blob, images, video };
}

type H = ReturnType<typeof setup>;

async function space(h: H) {
  await createSpace(h.ctx, {
    spaceId: scope.spaceId,
    name: 'Shop',
    defaultLocale: 'en-US',
    locales: ['en-US', 'de-DE', 'de-AT'],
    fallbacks: { 'de-AT': 'de-DE', 'de-DE': 'en-US' },
  });
}

/** An uploaded image with a title and alt text in two locales, a focal point and a credit. */
async function image(h: H, o: { width?: number; contentType?: string; fileName?: string } = {}) {
  const { asset } = await createAsset(h.ctx, h.blob, scope, {
    fileName: o.fileName ?? 'hero.jpg',
    contentType: o.contentType ?? 'image/jpeg',
    title: { 'en-US': 'Hero', 'de-DE': 'Held' },
  });
  const withFile: Asset = {
    ...asset,
    file: { ...asset.file, size: 1234, width: o.width ?? 1500, height: 1000 },
    rights: { credit: 'Ada', license: 'CC-BY', expiresAt: '2099-01-01T00:00:00.000Z' },
  };
  await h.store.assets.save(scope, withFile);
  await setAssetMetadata(h.ctx, scope, asset.id, {
    altText: { 'en-US': 'A hero', 'de-DE': 'Ein Held' },
    focalPoint: { x: 0.3, y: 0.6 },
  });
  return withFile;
}

describe('delivered assets', () => {
  let h: H;
  beforeEach(async () => {
    h = setup();
    await space(h);
  });

  it('projects a published image with media URLs, renditions and a srcset up to its width', async () => {
    const a = await image(h, { width: 1500 });
    await createAssetRendition(h.ctx, scope, {
      name: 'thumb',
      width: 200,
      height: 200,
      fit: 'crop',
    });
    await publishAsset(h.ctx, scope, a.id);

    const d = await getDeliveredAsset(h.ctx, scope, a.id);
    const base = mediaBase(a.id);
    expect(d).toMatchObject({
      id: a.id,
      kind: 'image',
      contentType: 'image/jpeg',
      size: 1234,
      width: 1500,
      height: 1000,
      focalPoint: { x: 0.3, y: 0.6 },
      url: `${base}/o/hero.jpg`,
      renditions: { thumb: `${base}/r-thumb/hero.jpg` },
      // Credit and license only: the expiry is the media origin's business.
      rights: { credit: 'Ada', license: 'CC-BY' },
      // Kept for existing readers, pointing at the public original.
      file: { url: `${base}/o/hero.jpg`, fileName: 'hero.jpg' },
    });
    expect(d.srcset).toEqual(
      [320, 640, 960, 1280].map((w) => ({ width: w, url: `${base}/w${w}/hero.jpg?fm=auto` })),
    );
    // Without ?locale, text is per locale.
    expect(d.title).toEqual({ 'en-US': 'Hero', 'de-DE': 'Held' });
    expect(d.altText).toEqual({ 'en-US': 'A hero', 'de-DE': 'Ein Held' });
    expect(d.video).toBeUndefined();
  });

  it('flattens title, description and alt text to a locale, with the space’s fallbacks', async () => {
    const a = await image(h);
    await publishAsset(h.ctx, scope, a.id);
    const de = await getDeliveredAsset(h.ctx, scope, a.id, { locale: 'de-AT' });
    expect(de).toMatchObject({ title: 'Held', altText: 'Ein Held', description: null });
    const en = await getDeliveredAsset(h.ctx, scope, a.id, { locale: 'en-US' });
    expect(en).toMatchObject({ title: 'Hero', altText: 'A hero' });
  });

  it('gives what the media origin can’t resize only its original', async () => {
    const svg = await image(h, { contentType: 'image/svg+xml', fileName: 'logo.svg' });
    const pdf = await image(h, { contentType: 'application/pdf', fileName: 'brief.pdf' });
    await createAssetRendition(h.ctx, scope, { name: 'thumb', width: 200 });
    for (const a of [svg, pdf]) {
      await publishAsset(h.ctx, scope, a.id);
      const d = await getDeliveredAsset(h.ctx, scope, a.id);
      expect(d.url).toBe(`${mediaBase(a.id)}/o/${a.file.fileName}`);
      expect(d.renditions).toEqual({});
      expect(d.srcset).toEqual([]);
    }
    expect((await getDeliveredAsset(h.ctx, scope, pdf.id)).kind).toBe('document');
  });

  it('carries a hosted video’s playback, and its manifest as the url', async () => {
    const { asset } = await createVideoAsset(h.ctx, scope, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
    });
    const videoId = asset.file.video?.videoId as string;
    h.video.setVideo(videoId, {
      status: 'ready',
      hlsUrl: 'https://stream.test/v.m3u8',
      thumbnailUrl: 'https://stream.test/t.jpg',
      durationSeconds: 12,
    });
    await refreshVideoAsset(h.ctx, scope, asset.id);
    await publishAsset(h.ctx, scope, asset.id);
    const d = await getDeliveredAsset(h.ctx, scope, asset.id);
    expect(d).toMatchObject({
      kind: 'video',
      url: 'https://stream.test/v.m3u8',
      video: {
        status: 'ready',
        hlsUrl: 'https://stream.test/v.m3u8',
        thumbnailUrl: 'https://stream.test/t.jpg',
        durationSeconds: 12,
      },
      renditions: {},
      srcset: [],
    });
  });

  it('keeps the stored URL and offers no variants without a media origin', async () => {
    const plain = setup({ media: false });
    await space(plain);
    const a = await image(plain);
    await publishAsset(plain.ctx, scope, a.id);
    const d = await getDeliveredAsset(plain.ctx, scope, a.id);
    expect(d.url).toBe(a.file.url);
    expect(d.srcset).toEqual([]);
    expect(d.renditions).toEqual({});
  });

  it('embeds the same shape in entries, flattened to the entry’s locale', async () => {
    const a = await image(h);
    await publishAsset(h.ctx, scope, a.id);
    await createContentType(h.ctx, SYSTEM_CALLER, scope, {
      apiId: 'page',
      name: 'Page',
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
    await publishContentType(h.ctx, scope, 'page');
    const { entry } = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': 'Home' },
        hero: { 'en-US': { id: a.id, linkType: 'Asset' } },
      },
    });
    await publishEntry(h.ctx, scope, entry.id);
    const rendered = await getPublishedEntry(h.ctx, scope, entry.id, {
      locale: 'de-DE',
      include: 1,
    });
    expect(rendered.fields.hero).toEqual(
      await getDeliveredAsset(h.ctx, scope, a.id, { locale: 'de-DE' }),
    );
  });

  it('lists published assets a page at a time, filtered by kind, tag and folder', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const a = await image(h, { fileName: `p${i}.jpg` });
      await publishAsset(h.ctx, scope, a.id);
      ids.push(a.id);
    }
    const pdf = await image(h, { contentType: 'application/pdf', fileName: 'x.pdf' });
    await publishAsset(h.ctx, scope, pdf.id);
    await setAssetMetadata(h.ctx, scope, ids[1] as string, { tags: ['summer'] });
    await publishAsset(h.ctx, scope, ids[1] as string);
    // A draft is never listed.
    await image(h, { fileName: 'draft.jpg' });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listDeliveredAssets(h.ctx, scope, {
        limit: 2,
        filters: { kind: 'image' },
        ...(cursor ? { cursor } : {}),
      });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((a) => a.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual([...ids].sort());

    const tagged = await listDeliveredAssets(h.ctx, scope, { filters: { tag: 'summer' } });
    expect(tagged.items.map((a) => a.id)).toEqual([ids[1]]);
    const docs = await listDeliveredAssets(h.ctx, scope, { filters: { kind: 'document' } });
    expect(docs.items.map((a) => a.id)).toEqual([pdf.id]);
    const root = await listDeliveredAssets(h.ctx, scope, { filters: { folderId: null } });
    expect(root.items).toHaveLength(6);
  });

  it('keeps one scope’s assets out of another’s reads', async () => {
    const a = await image(h);
    await publishAsset(h.ctx, scope, a.id);
    const other = { spaceId: 'shop', environmentId: 'staging' };
    await expect(getDeliveredAsset(h.ctx, other, a.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listDeliveredAssets(h.ctx, other)).items).toEqual([]);
  });

  it('points the deprecated transform at the ladder step or rendition', async () => {
    const a = await image(h);
    await publishAsset(h.ctx, scope, a.id);
    await createAssetRendition(h.ctx, scope, {
      name: 'card',
      width: 600,
      height: 400,
      fit: 'crop',
    });
    const base = mediaBase(a.id);
    expect(await assetTransformTarget(h.ctx, scope, a.id, { width: 500 })).toBe(
      `${base}/w640/hero.jpg?fm=auto`,
    );
    expect(await assetTransformTarget(h.ctx, scope, a.id, { width: 9999 })).toBe(
      `${base}/w2560/hero.jpg?fm=auto`,
    );
    expect(await assetTransformTarget(h.ctx, scope, a.id, { rendition: 'card' })).toBe(
      `${base}/r-card/hero.jpg`,
    );
    expect(await assetTransformTarget(h.ctx, scope, a.id, {})).toBe(`${base}/o/hero.jpg`);
    await expect(
      assetTransformTarget(h.ctx, scope, a.id, { rendition: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const pdf = await image(h, { contentType: 'application/pdf', fileName: 'x.pdf' });
    await publishAsset(h.ctx, scope, pdf.id);
    await expect(assetTransformTarget(h.ctx, scope, pdf.id, { width: 640 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('preview and management reads', () => {
  let h: H;
  beforeEach(async () => {
    h = setup();
    await space(h);
  });

  it('hands out short-lived signed URLs, never the stored one', async () => {
    const a = await image(h);
    const read = await withReadUrl(h.blob, scope, await getAsset(h.ctx, scope, a.id));
    expect(read.file.url).toBe(`https://blob.local/${a.r2Key}?ttl=${READ_URL_TTL_SECONDS}`);
    expect(read.file.url).not.toBe(a.file.url);
  });

  it('projects drafts with signed originals and expiring variants on the media origin', async () => {
    const a = await image(h, { width: 700 });
    await createAssetRendition(h.ctx, scope, { name: 'thumb', width: 100 });
    const d = await getPreviewAsset(h.ctx, h.blob, scope, a.id, { locale: 'en-US' });
    expect(d.url).toBe(`${MEDIA}/${a.r2Key}?ttl=${READ_URL_TTL_SECONDS}`);
    expect(d.title).toBe('Hero');
    expect(Object.keys(d.renditions)).toEqual(['thumb']);
    expect(d.srcset.map((s) => s.width)).toEqual([320, 640]);
    // Every variant is the image service's transform of the signed original, expiring with it,
    // cropped toward the focal point.
    expect(h.images.calls).toHaveLength(3);
    for (const call of h.images.calls) {
      expect(call.sourceUrl).toBe(d.url);
      expect(call.expiresInSeconds).toBe(READ_URL_TTL_SECONDS);
      expect(call.focalPoint).toEqual({ x: 0.3, y: 0.6 });
    }
    expect(h.images.calls.find((c) => c.transform.width === 640)?.transform).toEqual({
      width: 640,
      fit: 'max',
      format: 'auto',
    });
  });

  it('never serves a recorded key that is not this asset’s (as an imported snapshot can claim)', async () => {
    const a = await image(h);
    const own = assetObjectKey(scope, a.id, a.file.fileName);
    for (const forged of [
      'versions/other/main/entry-1/1.json', // another space's archived version body
      `versions/main/${a.id}/x.jpg`, // the same, through a space named `versions`
      'other/main/someone-elses-asset/x.jpg', // another asset's file
      `shop/../${a.id}/x.jpg`,
    ]) {
      await h.store.assets.save(scope, { ...a, r2Key: forged });
      const read = await withReadUrl(h.blob, scope, await getAsset(h.ctx, scope, a.id));
      expect(read.file.url).toBe(`https://blob.local/${own}?ttl=${READ_URL_TTL_SECONDS}`);
      await publishAsset(h.ctx, scope, a.id);
      const snapshot = await getPublishedAsset(h.ctx, scope, a.id);
      expect(snapshot && assetGateEntry(scope, snapshot)?.r2Key).toBe(own);
    }
  });

  it('keeps a recorded key from another environment (an import shares its source’s files)', async () => {
    const a = await image(h);
    const source = `shop/staging/${a.id}/hero.jpg`;
    await h.store.assets.save(scope, { ...a, r2Key: source });
    const read = await withReadUrl(h.blob, scope, await getAsset(h.ctx, scope, a.id));
    expect(read.file.url).toBe(`https://blob.local/${source}?ttl=${READ_URL_TTL_SECONDS}`);
  });

  it('lists drafts for Preview but never an archived asset', async () => {
    const kept = await image(h, { fileName: 'a.jpg' });
    const gone = await image(h, { fileName: 'b.jpg' });
    await archiveAsset(h.ctx, scope, gone.id);
    const page = await listPreviewAssets(h.ctx, h.blob, scope);
    expect(page.items.map((a) => a.id)).toEqual([kept.id]);
    await expect(getPreviewAsset(h.ctx, h.blob, scope, gone.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('a hosted video refreshed after it was published', () => {
  it('moves the published snapshot on too, and says so with an event', async () => {
    const h = setup();
    await space(h);
    const { asset } = await createVideoAsset(h.ctx, scope, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      title: { 'en-US': 'Clip' },
    });
    // Published while the host is still encoding.
    await publishAsset(h.ctx, scope, asset.id);
    expect((await h.store.assets.getPublished(scope, asset.id))?.file.video?.status).toBe(
      'pending',
    );
    const before = h.store.allEvents().length;

    h.video.setVideo(asset.file.video?.videoId as string, {
      status: 'ready',
      hlsUrl: 'https://stream.test/v.m3u8',
      width: 1920,
      height: 1080,
    });
    await refreshVideoAsset(h.ctx, scope, asset.id);

    const snapshot = await h.store.assets.getPublished(scope, asset.id);
    expect(snapshot?.file).toMatchObject({
      url: 'https://stream.test/v.m3u8',
      width: 1920,
      video: { status: 'ready', hlsUrl: 'https://stream.test/v.m3u8' },
    });
    // What was published otherwise stays as it was.
    expect(snapshot?.title).toEqual({ 'en-US': 'Clip' });
    const events = h.store.allEvents().slice(before) as DomainEvent[];
    expect(events.map((e) => e.type)).toEqual(['asset.published']);

    // Refreshed again (a redelivered webhook): the same snapshot, one more purge.
    await refreshVideoAsset(h.ctx, scope, asset.id);
    expect((await h.store.assets.getPublished(scope, asset.id))?.file).toEqual(snapshot?.file);
  });

  it('refuses, rather than brings back, an asset deleted while the host was asked', async () => {
    const h = setup();
    await space(h);
    const { asset } = await createVideoAsset(h.ctx, scope, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
    });
    const videoId = asset.file.video?.videoId as string;
    h.video.setVideo(videoId, { status: 'ready', hlsUrl: 'x.m3u8' });
    const getVideo = h.video.getVideo.bind(h.video);
    h.video.getVideo = async (id) => {
      await h.store.assets.delete(scope, asset.id);
      return getVideo(id);
    };
    await expect(refreshVideoAsset(h.ctx, scope, asset.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await h.store.assets.get(scope, asset.id)).toBeNull();
  });

  it('touches only the draft while the asset isn’t published', async () => {
    const h = setup();
    await space(h);
    const { asset } = await createVideoAsset(h.ctx, scope, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
    });
    h.video.setVideo(asset.file.video?.videoId as string, { status: 'ready', hlsUrl: 'x.m3u8' });
    const before = h.store.allEvents().length;
    await refreshVideoAsset(h.ctx, scope, asset.id);
    expect(await h.store.assets.getPublished(scope, asset.id)).toBeNull();
    expect(h.store.allEvents()).toHaveLength(before);
  });
});
