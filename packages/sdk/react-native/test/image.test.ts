import type { DeliveredAsset } from '@commerceworker/sdk-core';
import { describe, expect, it } from 'vitest';
import { imageSource, imageUrl } from '../src/image.js';

const asset: Pick<DeliveredAsset, 'url' | 'renditions' | 'srcset'> = {
  url: 'https://media.test/s/main/a/v1/Q2p8kT1vXn4bR7sW0yZa3c/o/a.jpg',
  renditions: { thumb: 'https://media.test/s/main/a/v1/Q2p8kT1vXn4bR7sW0yZa3c/r-thumb/a.jpg' },
  srcset: [
    { width: 320, url: 'https://media.test/s/main/a/v1/Q2p8kT1vXn4bR7sW0yZa3c/w320/a.jpg?fm=auto' },
    { width: 640, url: 'https://media.test/s/main/a/v1/Q2p8kT1vXn4bR7sW0yZa3c/w640/a.jpg?fm=auto' },
    { width: 960, url: 'https://media.test/s/main/a/v1/Q2p8kT1vXn4bR7sW0yZa3c/w960/a.jpg?fm=auto' },
  ],
};

describe('imageUrl', () => {
  it('takes the width step at or above width × dpr', () => {
    expect(imageUrl(asset, { width: 300 })).toBe(asset.srcset[0]?.url);
    expect(imageUrl(asset, { width: 300, dpr: 2 })).toBe(asset.srcset[1]?.url);
    expect(imageUrl(asset, { width: 300, dpr: 3 })).toBe(asset.srcset[2]?.url);
  });

  it('prefers a rendition the asset has, and falls back when it has none', () => {
    expect(imageUrl(asset, { rendition: 'thumb', width: 900 })).toBe(asset.renditions.thumb);
    expect(imageUrl(asset, { rendition: 'nope', width: 600 })).toBe(asset.srcset[1]?.url);
    expect(imageUrl(asset, { rendition: 'nope' })).toBe(asset.url);
  });

  it('never adds parameters to the URL it was given', () => {
    const signed = { ...asset, url: 'https://media.test/media/k?exp=1&sig=x', srcset: [] };
    expect(imageUrl(signed, { width: 400, dpr: 2 })).toBe(signed.url);
    expect(imageUrl(signed)).toBe(signed.url);
  });
});

const full: DeliveredAsset = {
  ...asset,
  id: 'a1',
  title: 'Hero',
  description: null,
  altText: 'A hill',
  focalPoint: null,
  contentType: 'image/jpeg',
  size: 1000,
  width: 1200,
  height: 800,
  kind: 'image',
  placeholder: null,
  file: { url: asset.url },
};

describe('imageSource', () => {
  it('takes the step for width × dpr and sizes the source in dp from the aspect ratio', () => {
    expect(imageSource(full, { width: 300, dpr: 3 })).toEqual({
      uri: asset.srcset[2]?.url,
      width: 300,
      height: 200,
    });
    expect(imageSource(full, { width: 300 })?.uri).toBe(asset.srcset[0]?.url);
    expect(imageSource(full)).toEqual({ uri: asset.url });
  });

  it('serves a rendition without guessing its height, and falls back past a missing one', () => {
    expect(imageSource(full, { rendition: 'thumb', width: 100 })).toEqual({
      uri: asset.renditions.thumb,
      width: 100,
    });
    expect(imageSource(full, { rendition: 'nope', width: 600 })).toEqual({
      uri: asset.srcset[1]?.url,
      width: 600,
      height: 400,
    });
  });

  it('is the original without a ladder (local dev)', () => {
    const local = { ...full, url: '/media/k?sig=x', srcset: [], renditions: {} };
    expect(imageSource(local, { width: 300, dpr: 2 })).toEqual({
      uri: '/media/k?sig=x',
      width: 300,
      height: 200,
    });
  });

  it('gives a hosted video’s thumbnail, and nothing for a document', () => {
    const video = {
      ...full,
      kind: 'video' as const,
      srcset: [],
      renditions: {},
      video: { status: 'ready', thumbnailUrl: 'https://stream.test/t.jpg' },
    };
    expect(imageSource(video)?.uri).toBe('https://stream.test/t.jpg');
    expect(imageSource({ ...full, kind: 'document' })).toBeUndefined();
  });
});
