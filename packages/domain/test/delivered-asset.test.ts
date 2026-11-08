import { describe, expect, it } from 'vitest';
import {
  ASSET_WIDTH_LADDER,
  assetMediaPath,
  assetRenditionName,
  assetRenditionSpec,
  deliveredAsset,
  parseAssetMediaPath,
  parseAssetVariant,
  publicAssetUrls,
  ValidationError,
  variantForTransform,
  variantSegment,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };
/** A path token's shape (16 bytes, base64url); the signer makes real ones. */
const T = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('media URLs', () => {
  it('round-trip every variant, encoding what needs it', () => {
    for (const variant of [
      { kind: 'original' as const },
      { kind: 'width' as const, width: 640 },
      { kind: 'rendition' as const, name: 'hero-2x' },
    ]) {
      const address = {
        scope,
        assetId: 'a1',
        version: 3,
        token: T,
        variant,
        fileName: 'my photo #1.jpg',
      };
      const path = assetMediaPath(address);
      expect(path).toBe(`/shop/main/a1/v3/${T}/${variantSegment(variant)}/my%20photo%20%231.jpg`);
      expect(parseAssetMediaPath(path)).toEqual(address);
    }
  });

  it('refuse a width off the ladder, a bad version, token or segment, and traversal', () => {
    for (const bad of [
      `/shop/main/a1/v1/${T}/w641/x.jpg`,
      `/shop/main/a1/v1/${T}/w100/x.jpg`,
      `/shop/main/a1/v0/${T}/o/x.jpg`,
      `/shop/main/a1/1/${T}/o/x.jpg`,
      `/shop/main/a1/v1/${T}/r-Hero/x.jpg`,
      `/shop/main/a1/v1/${T}/q/x.jpg`,
      `/shop/main/../v1/${T}/o/x.jpg`,
      `/shop/main/a1/v1/${T}/o/x.jpg/extra`,
      `/shop/main/a1/v1/${T}/o/%E0%A4%A`,
      // No token (the old shape), a short one, and one with a character outside base64url.
      '/shop/main/a1/v1/o/x.jpg',
      '/shop/main/a1/v1/AAAA/o/x.jpg',
      `/shop/main/a1/v1/${T.slice(1)}=/o/x.jpg`,
    ]) {
      expect(parseAssetMediaPath(bad), bad).toBeNull();
    }
    for (const w of ASSET_WIDTH_LADDER)
      expect(parseAssetVariant(`w${w}`)).toEqual({ kind: 'width', width: w });
  });

  it('send a legacy transform to the next step up, or the largest', () => {
    expect(variantForTransform({ width: 1 })).toEqual({ kind: 'width', width: 320 });
    expect(variantForTransform({ width: 640 })).toEqual({ kind: 'width', width: 640 });
    expect(variantForTransform({ width: 641 })).toEqual({ kind: 'width', width: 960 });
    expect(variantForTransform({ width: 99999 })).toEqual({ kind: 'width', width: 2560 });
    expect(variantForTransform({})).toEqual({ kind: 'original' });
    expect(variantForTransform({ rendition: 'card', width: 10 })).toEqual({
      kind: 'rendition',
      name: 'card',
    });
    expect(() => variantForTransform({ rendition: '../x' })).toThrow(ValidationError);
  });
});

describe('rendition presets', () => {
  it('keep only the fields they set, and need one of width, height or format', () => {
    expect(assetRenditionSpec({ width: 10, fit: 'crop' })).toEqual({ width: 10, fit: 'crop' });
    expect(assetRenditionSpec({ format: 'webp' })).toEqual({ format: 'webp' });
    expect(() => assetRenditionSpec({ fit: 'crop' })).toThrow(ValidationError);
    expect(() => assetRenditionSpec({ width: 1.5 })).toThrow(ValidationError);
    expect(assetRenditionName('og-image')).toBe('og-image');
    expect(() => assetRenditionName('OG')).toThrow(ValidationError);
  });
});

describe('deliveredAsset', () => {
  const asset = {
    id: 'a1',
    file: {
      url: 'https://api.test/media/shop/main/a1/x.png?sig=s',
      fileName: 'x.png',
      contentType: 'image/png',
      width: 700,
    },
    title: { 'en-US': 'Title' },
    description: {},
    metadata: { altText: { 'en-US': 'Alt' } },
  };

  it('builds every URL from the builder, never from the stored URL', () => {
    const d = deliveredAsset(asset, {
      urlFor: publicAssetUrls('https://media.test/', scope, {
        id: 'a1',
        version: 2,
        fileName: 'x.png',
        token: T,
      }),
      renditions: ['thumb'],
    });
    expect(d.url).toBe(`https://media.test/shop/main/a1/v2/${T}/o/x.png`);
    expect(d.file.url).toBe(d.url);
    expect(d.renditions).toEqual({
      thumb: `https://media.test/shop/main/a1/v2/${T}/r-thumb/x.png`,
    });
    expect(d.srcset.map((s) => s.width)).toEqual([320, 640]);
    expect(d.title).toEqual({ 'en-US': 'Title' });
    expect(d.rights).toBeUndefined();
  });

  it('leaves out a variant the builder can’t serve', () => {
    const d = deliveredAsset(asset, {
      urlFor: (v) => (v.kind === 'original' ? 'signed' : undefined),
      renditions: ['thumb'],
      locale: {
        requested: 'fr-FR',
        config: { defaultLocale: 'en-US', locales: ['en-US', 'fr-FR'] },
      },
    });
    expect(d).toMatchObject({
      url: 'signed',
      renditions: {},
      srcset: [],
      title: 'Title',
      description: null,
    });
  });

  it('carries the placeholder ingest computed, and null without one or for a hosted video', () => {
    const placeholder = {
      thumbhash: 'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw==',
      dominantColor: '#a07850',
    };
    expect(deliveredAsset(asset, { renditions: [] }).placeholder).toBeNull();
    const d = deliveredAsset(
      { ...asset, file: { ...asset.file, placeholder } },
      { renditions: [] },
    );
    expect(d.placeholder).toEqual(placeholder);
    const video = deliveredAsset(
      {
        ...asset,
        file: {
          ...asset.file,
          placeholder,
          video: { provider: 'stream', videoId: 'v', status: 'ready' as const },
        },
      },
      { renditions: [] },
    );
    expect(video.placeholder).toBeNull();
  });
});
