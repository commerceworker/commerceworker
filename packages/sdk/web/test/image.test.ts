// @vitest-environment jsdom
import type { DeliveredAsset, DeliveryClient } from '@commerceworker/sdk-core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { CommerceworkerProvider, Image, useAsset } from '../src/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c';
const asset: DeliveredAsset = {
  id: 'a1',
  title: { 'en-US': 'Hero', 'de-DE': 'Held' },
  description: null,
  altText: { 'en-US': 'A hill', 'de-DE': 'Ein Hügel' },
  focalPoint: { x: 0.25, y: 0.75 },
  contentType: 'image/jpeg',
  size: 1000,
  width: 1000,
  height: 500,
  kind: 'image',
  url: `${base}/o/hero.jpg`,
  renditions: { thumb: `${base}/r-thumb/hero.jpg` },
  srcset: [
    { width: 320, url: `${base}/w320/hero.jpg?fm=auto` },
    { width: 640, url: `${base}/w640/hero.jpg?fm=auto` },
  ],
  placeholder: { thumbhash: '3PcN', dominantColor: '#112233' },
  file: { url: `${base}/o/hero.jpg` },
};

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(el);
  return host.querySelector('img');
};

describe('<Image>', () => {
  it('renders the srcset, sizes, intrinsic size, localized alt and style onto <img>', () => {
    const img = render(createElement(Image, { asset, width: 400, locale: 'de-DE' }));
    expect(img?.getAttribute('src')).toBe(asset.srcset[1]?.url);
    expect(img?.getAttribute('srcset')).toBe(
      // The image (1000px) is wider than the ladder's last step, so the original tops it.
      `${base}/w320/hero.jpg?fm=auto 320w, ${base}/w640/hero.jpg?fm=auto 640w, ${base}/o/hero.jpg 1000w`,
    );
    expect(img?.getAttribute('sizes')).toBe('(max-width: 400px) 100vw, 400px');
    expect([img?.getAttribute('width'), img?.getAttribute('height')]).toEqual(['400', '200']);
    expect(img?.getAttribute('alt')).toBe('Ein Hügel');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('decoding')).toBe('async');
    expect(img?.hasAttribute('fetchpriority')).toBe(false);
    expect(img?.style.objectPosition).toBe('25% 75%');
    expect(img?.style.backgroundColor).toBe('rgb(17, 34, 51)');
  });

  it('marks a priority image eager and high priority', () => {
    const img = render(createElement(Image, { asset, priority: true }));
    expect(img?.getAttribute('loading')).toBe('eager');
    expect(img?.getAttribute('fetchpriority')).toBe('high');
  });

  it('falls back to the title for alt, then to empty; an explicit alt wins', () => {
    expect(render(createElement(Image, { asset: { ...asset, altText: null } }))?.alt).toBe('Hero');
    const bare = { ...asset, altText: null, title: null };
    expect(render(createElement(Image, { asset: bare }))?.getAttribute('alt')).toBe('');
    expect(render(createElement(Image, { asset, alt: 'Mine' }))?.alt).toBe('Mine');
  });

  it('serves a rendition as the one src', () => {
    const img = render(createElement(Image, { asset, rendition: 'thumb' }));
    expect(img?.getAttribute('src')).toBe(asset.renditions.thumb);
    expect(img?.hasAttribute('srcset')).toBe(false);
  });

  it('renders src alone without a ladder (local dev), and passes other attributes through', () => {
    const local = { ...asset, url: '/media/k?sig=x', srcset: [], renditions: {} };
    const img = render(
      createElement(Image, { asset: local, className: 'hero', style: { borderRadius: 4 } }),
    );
    expect(img?.getAttribute('src')).toBe('/media/k?sig=x');
    expect(img?.hasAttribute('srcset')).toBe(false);
    expect(img?.hasAttribute('sizes')).toBe(false);
    expect(img?.className).toBe('hero');
    expect(img?.style.borderRadius).toBe('4px');
    expect(img?.style.objectPosition).toBe('25% 75%');
  });

  it('keeps a hostile dominant colour out of the server-rendered style', () => {
    const hostile = {
      ...asset,
      placeholder: { thumbhash: '', dominantColor: 'red;background-image:url(https://evil.test)' },
    };
    expect(renderToStaticMarkup(createElement(Image, { asset: hostile }))).not.toContain('evil');
  });

  it('renders nothing while the asset loads, or for one with no image', () => {
    expect(renderToStaticMarkup(createElement(Image, { asset: undefined }))).toBe('');
    const pdf = { ...asset, kind: 'document' as const, contentType: 'application/pdf' };
    expect(renderToStaticMarkup(createElement(Image, { asset: pdf }))).toBe('');
  });
});

const seen: { loading: boolean; id?: string; error?: Error }[] = [];

function Probe() {
  const state = useAsset('a1', { locale: 'en-US' });
  seen.push({ loading: state.loading, id: state.data?.id, error: state.error });
  return null;
}

describe('useAsset', () => {
  let root: ReturnType<typeof createRoot> | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  it('fetches the asset with its locale and exposes it as data', async () => {
    const calls: unknown[][] = [];
    const client = {
      getAsset: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(asset);
      },
    } as unknown as DeliveryClient;
    seen.length = 0;
    const host = document.createElement('div');
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(CommerceworkerProvider, { client }, createElement(Probe)));
    });
    expect(calls).toEqual([['a1', { locale: 'en-US' }]]);
    expect(seen[0]).toEqual({ loading: true, id: undefined, error: undefined });
    expect(seen.at(-1)).toEqual({ loading: false, id: 'a1', error: undefined });
  });

  it('surfaces a failed fetch as error', async () => {
    const client = {
      getAsset: () => Promise.reject(new Error('gone')),
    } as unknown as DeliveryClient;
    seen.length = 0;
    root = createRoot(document.createElement('div'));
    await act(async () => {
      root?.render(createElement(CommerceworkerProvider, { client }, createElement(Probe)));
    });
    expect(seen.at(-1)?.error?.message).toBe('gone');
  });
});
