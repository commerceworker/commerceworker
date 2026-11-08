// @vitest-environment jsdom
import type { DeliveredAsset, DeliveryClient } from '@commerceworker/sdk-core';
import { describe, expect, it } from 'vitest';
import { createApp, createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { CwImage, createCommerceworker, useAsset } from '../src/index.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

/** Mounts `<CwImage>` with `props` and returns its `<img>` (or null) and the host. */
function mount(props: Record<string, unknown>) {
  const host = document.createElement('div');
  const app = createApp(defineComponent({ render: () => h(CwImage, props) }));
  app.mount(host);
  return { img: host.querySelector('img'), host, app };
}

describe('<CwImage>', () => {
  it('renders the srcset, sizes, intrinsic size, localized alt and style onto <img>', () => {
    const { img, app } = mount({ asset, width: 400, locale: 'de-DE' });
    expect(img?.getAttribute('src')).toBe(asset.srcset[1]?.url);
    expect(img?.getAttribute('srcset')).toBe(
      // The image (1000px) is wider than the ladder's last step, so the original tops it.
      `${base}/w320/hero.jpg?fm=auto 320w, ${base}/w640/hero.jpg?fm=auto 640w, ${base}/o/hero.jpg 1000w`,
    );
    expect(img?.getAttribute('sizes')).toBe('(max-width: 400px) 100vw, 400px');
    expect([img?.getAttribute('width'), img?.getAttribute('height')]).toEqual(['400', '200']);
    expect(img?.getAttribute('alt')).toBe('Ein Hügel');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.hasAttribute('fetchpriority')).toBe(false);
    expect(img?.style.objectPosition).toBe('25% 75%');
    expect(img?.style.backgroundColor).toBe('rgb(17, 34, 51)');
    app.unmount();
  });

  it('marks a priority image eager and high priority', () => {
    const { img, app } = mount({ asset, priority: true });
    expect(img?.getAttribute('loading')).toBe('eager');
    expect(img?.getAttribute('fetchpriority')).toBe('high');
    app.unmount();
  });

  it('falls back to the title for alt, then to empty; a fallthrough alt wins', () => {
    expect(mount({ asset: { ...asset, altText: null } }).img?.getAttribute('alt')).toBe('Hero');
    const bare = { ...asset, altText: null, title: null };
    expect(mount({ asset: bare }).img?.getAttribute('alt')).toBe('');
    expect(mount({ asset, alt: 'Mine' }).img?.getAttribute('alt')).toBe('Mine');
  });

  it('serves a rendition as the one src', () => {
    const { img } = mount({ asset, rendition: 'thumb' });
    expect(img?.getAttribute('src')).toBe(asset.renditions.thumb);
    expect(img?.hasAttribute('srcset')).toBe(false);
  });

  it('renders src alone without a ladder (local dev), merging class and style', () => {
    const local = { ...asset, url: '/media/k?sig=x', srcset: [], renditions: {} };
    const { img } = mount({ asset: local, class: 'hero', style: { borderRadius: '4px' } });
    expect(img?.getAttribute('src')).toBe('/media/k?sig=x');
    expect(img?.hasAttribute('srcset')).toBe(false);
    expect(img?.hasAttribute('sizes')).toBe(false);
    expect(img?.className).toBe('hero');
    expect(img?.style.borderRadius).toBe('4px');
    expect(img?.style.objectPosition).toBe('25% 75%');
  });

  it('keeps a hostile dominant colour out of the server-rendered style', async () => {
    const hostile = {
      ...asset,
      placeholder: { thumbhash: '', dominantColor: 'red;background-image:url(https://evil.test)' },
    };
    const html = await renderToString(
      createSSRApp({ render: () => h(CwImage, { asset: hostile }) }),
    );
    expect(html).toContain('<img');
    expect(html).not.toContain('evil');
  });

  it('renders nothing while the asset loads, or for one with no image', () => {
    expect(mount({ asset: undefined }).img).toBeNull();
    const pdf = { ...asset, kind: 'document', contentType: 'application/pdf' };
    expect(mount({ asset: pdf }).img).toBeNull();
  });
});

describe('useAsset', () => {
  it('fetches the asset with its locale on mount and exposes it as data', async () => {
    const calls: unknown[][] = [];
    const client = {
      getAsset: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(asset);
      },
    } as unknown as DeliveryClient;
    let state: ReturnType<typeof useAsset> | undefined;
    const app = createApp(
      defineComponent({
        setup() {
          state = useAsset('a1', { locale: 'en-US' });
          return () => h('div');
        },
      }),
    );
    app.use(createCommerceworker(client));
    app.mount(document.createElement('div'));
    expect(state?.loading.value).toBe(true);
    await flush();
    expect(calls).toEqual([['a1', { locale: 'en-US' }]]);
    expect(state?.data.value?.id).toBe('a1');
    expect(state?.loading.value).toBe(false);
    app.unmount();
  });
});
