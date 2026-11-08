import { describe, expect, it } from 'vitest';
import { type DeliveredAsset, imageProps, localizedText } from '../src/index.js';

const base = 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c';
const image: DeliveredAsset = {
  id: 'a1',
  title: 'Hero',
  description: null,
  altText: 'A hill',
  focalPoint: { x: 0.5, y: 0.25 },
  contentType: 'image/jpeg',
  size: 1000,
  // As wide as the last ladder step, so the ladder is complete (see "past the ladder" below).
  width: 960,
  height: 576,
  kind: 'image',
  url: `${base}/o/hero.jpg`,
  renditions: { thumb: `${base}/r-thumb/hero.jpg` },
  srcset: [
    { width: 320, url: `${base}/w320/hero.jpg?fm=auto` },
    { width: 640, url: `${base}/w640/hero.jpg?fm=auto` },
    { width: 960, url: `${base}/w960/hero.jpg?fm=auto` },
  ],
  placeholder: { thumbhash: '3PcNNYSFeXh/', dominantColor: '#3b4a2f' },
  file: { url: `${base}/o/hero.jpg` },
};

describe('imageProps', () => {
  it('puts the ladder in srcSet with sizes, and the intrinsic size, alt and placeholder', () => {
    expect(imageProps(image)).toEqual({
      src: image.url,
      srcSet: `${base}/w320/hero.jpg?fm=auto 320w, ${base}/w640/hero.jpg?fm=auto 640w, ${base}/w960/hero.jpg?fm=auto 960w`,
      sizes: '100vw',
      width: 960,
      height: 576,
      alt: 'A hill',
      loading: 'lazy',
      decoding: 'async',
      style: { objectPosition: '50% 25%', backgroundColor: '#3b4a2f' },
    });
  });

  it('takes src from the step at or above a target width, scaling width and height to it', () => {
    const props = imageProps(image, { width: 500 });
    expect(props?.src).toBe(image.srcset[1]?.url);
    expect(props?.sizes).toBe('(max-width: 500px) 100vw, 500px');
    expect([props?.width, props?.height]).toEqual([500, 300]);
    expect(imageProps(image, { width: 5000 })?.src).toBe(image.srcset[2]?.url);
    expect(imageProps(image, { width: 500, sizes: '50vw' })?.sizes).toBe('50vw');
  });

  it('offers the original past the ladder when the image is wider than its last step', () => {
    const wide = { ...image, width: 1900, height: 1000 };
    const props = imageProps(wide, { width: 1600 });
    expect(props?.srcSet?.endsWith(`, ${image.url} 1900w`)).toBe(true);
    expect(props?.src).toBe(image.url);
    // At or under the last step's width the ladder is complete.
    expect(imageProps({ ...image, width: 960 })?.srcSet).not.toContain(image.url);
  });

  it('serves a rendition the asset has as the one src, and ignores one it lacks', () => {
    const named = imageProps(image, { rendition: 'thumb' });
    expect(named?.src).toBe(image.renditions.thumb);
    expect(named?.srcSet).toBeUndefined();
    expect(named?.width).toBeUndefined();
    expect(imageProps(image, { rendition: 'thumb', width: 200 })).toMatchObject({ width: 200 });
    expect(imageProps(image, { rendition: 'thumb', width: 200 })).not.toHaveProperty('height');
    expect(imageProps(image, { rendition: 'nope' })?.srcSet).toContain('320w');
  });

  it('degrades to src alone when there is no ladder (local dev, no media origin)', () => {
    const local = {
      ...image,
      url: '/media/k?exp=1&sig=x',
      srcset: [],
      renditions: {},
    };
    const props = imageProps(local, { width: 400, rendition: 'thumb' });
    expect(props?.src).toBe('/media/k?exp=1&sig=x');
    expect(props?.srcSet).toBeUndefined();
    expect(props?.sizes).toBeUndefined();
    expect([props?.width, props?.height]).toEqual([400, 240]);
  });

  it('falls back from alt text to the title, then to empty (decorative)', () => {
    expect(imageProps({ ...image, altText: null })?.alt).toBe('Hero');
    expect(imageProps({ ...image, altText: '  ' })?.alt).toBe('Hero');
    expect(imageProps({ ...image, altText: null, title: null })?.alt).toBe('');
  });

  it('picks alt text by locale from a per-locale map, never another locale’s', () => {
    const multi = {
      ...image,
      altText: { 'en-US': 'A hill', 'de-DE': 'Ein Hügel' },
      title: { 'en-US': 'Hero', 'fr-FR': 'Héros' },
    };
    expect(imageProps(multi, { locale: 'de-DE' })?.alt).toBe('Ein Hügel');
    expect(imageProps(multi, { locale: 'fr-FR' })?.alt).toBe('Héros');
    expect(imageProps(multi, { locale: 'it-IT' })?.alt).toBe('');
    expect(imageProps(multi)?.alt).toBe('A hill');
  });

  it('loads a priority image eagerly with high fetch priority', () => {
    const props = imageProps(image, { priority: true });
    expect(props?.loading).toBe('eager');
    expect(props?.fetchPriority).toBe('high');
    expect(imageProps(image)).not.toHaveProperty('fetchPriority');
  });

  it('clamps the focal point and leaves style empty without focal point or placeholder', () => {
    expect(imageProps({ ...image, focalPoint: { x: 1.5, y: -1 } })?.style.objectPosition).toBe(
      '100% 0%',
    );
    expect(imageProps({ ...image, focalPoint: { x: 1 / 3, y: 0.125 } })?.style).toMatchObject({
      objectPosition: '33.33% 12.5%',
    });
    expect(imageProps({ ...image, focalPoint: null, placeholder: null })?.style).toEqual({});
  });

  it('drops a dominant colour that is not #rrggbb rather than passing it into style', () => {
    const style = (dominantColor: string) =>
      imageProps({ ...image, placeholder: { thumbhash: '', dominantColor } })?.style;
    expect(style('red; background-image: url(https://evil.test/x)')).not.toHaveProperty(
      'backgroundColor',
    );
    expect(style('#abc')).not.toHaveProperty('backgroundColor');
    expect(style('#ABCDEF')?.backgroundColor).toBe('#ABCDEF');
  });

  it('refuses URLs that are not http(s) or relative', () => {
    expect(imageProps({ ...image, url: 'javascript:alert(1)', srcset: [] })).toBeUndefined();
    expect(imageProps({ ...image, url: 'java\nscript:alert(1)', srcset: [] })).toBeUndefined();
    const props = imageProps({
      ...image,
      srcset: [
        { width: 320, url: 'data:image/svg+xml,<svg/>' },
        { width: 640, url: `${base}/w640/a b.jpg` },
        { width: 960, url: `${base}/w960/hero.jpg?fm=auto` },
      ],
    });
    expect(props?.srcSet).toBe(`${base}/w960/hero.jpg?fm=auto 960w`);
    expect(imageProps({ ...image, renditions: { x: 'vbscript:x' } }, { rendition: 'x' })?.src).toBe(
      image.url,
    );
  });

  it('ignores a rendition name that is a prototype key, not an own one', () => {
    for (const rendition of ['__proto__', 'constructor', 'toString']) {
      expect(imageProps(image, { rendition })?.srcSet).toContain('320w');
    }
  });

  it('leaves out ladder steps that would split or add a srcset candidate', () => {
    const props = imageProps({
      ...image,
      srcset: [
        { width: '1w, https://other.test/x.jpg 2000' as unknown as number, url: `${base}/w1.jpg` },
        { width: 0, url: `${base}/w0.jpg` },
        { width: 640, url: `${base}/w640/hero.jpg,` },
        { width: 960, url: 42 as unknown as string },
        { width: 960, url: `${base}/w960/hero.jpg?fm=auto` },
      ],
    });
    expect(props?.srcSet).toBe(`${base}/w960/hero.jpg?fm=auto 960w`);
  });

  it('shows a hosted video’s thumbnail, and nothing for audio, documents or a bare video', () => {
    const video = {
      ...image,
      kind: 'video' as const,
      contentType: 'video/mp4',
      url: 'https://stream.test/v/manifest/video.m3u8',
      srcset: [],
      renditions: {},
      placeholder: null,
      video: { status: 'ready', thumbnailUrl: 'https://stream.test/v/thumbnails/thumbnail.jpg' },
    };
    const props = imageProps(video, { width: 480 });
    expect(props?.src).toBe('https://stream.test/v/thumbnails/thumbnail.jpg');
    expect(props?.srcSet).toBeUndefined();
    expect([props?.width, props?.height]).toEqual([480, 288]);
    expect(imageProps({ ...video, video: { status: 'queued' } })).toBeUndefined();
    expect(imageProps({ ...image, kind: 'document', contentType: 'application/pdf' })).toBe(
      undefined,
    );
    expect(imageProps({ ...image, kind: 'audio' })).toBeUndefined();
  });

  it('gives an image without known dimensions only the target width', () => {
    const svg = { ...image, width: null, height: null, srcset: [], renditions: {} };
    expect(imageProps(svg)).not.toHaveProperty('width');
    expect(imageProps(svg, { width: 200 })).toMatchObject({ width: 200 });
    expect(imageProps(svg, { width: 200 })).not.toHaveProperty('height');
  });
});

describe('localizedText', () => {
  it('reads a flattened string, a locale key, or the first non-empty value', () => {
    expect(localizedText('Hi')).toBe('Hi');
    expect(localizedText({ 'en-US': '', 'de-DE': 'Hallo' })).toBe('Hallo');
    expect(localizedText({ 'en-US': 'Hi' }, 'de-DE')).toBeUndefined();
    expect(localizedText({ 'en-US': 42 })).toBeUndefined();
    expect(localizedText(null)).toBeUndefined();
  });
});
