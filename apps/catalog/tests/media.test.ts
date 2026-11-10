import { env } from 'cloudflare:workers';
import type { FeedStatus } from '@commerceworker/core/product';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, by, doc, product, settle, setup } from './helpers';

beforeAll(setup);

// The fleet sets MEDIA_ORIGIN only for a deployment with the assets service. This suite's Worker
// has none, as a commerce-only deployment; a test that needs the service sets it for its own run.
const vars = env as unknown as { MEDIA_ORIGIN?: string };
afterEach(() => {
  delete vars.MEDIA_ORIGIN;
});

/** The published `src` of each media item of a product, in order. */
async function srcs(key: string): Promise<string[]> {
  const media = ((await doc(key))?.media ?? []) as { src: string }[];
  return media.map((m) => m.src);
}

const external = [
  { src: 'https://cdn.merchant.example/tee front.jpg?v=3', alt: { en: 'Front' }, width: 800 },
  { src: 'https://dam.merchant.example/a/tee-back.png' },
];

describe('product media without the assets service', () => {
  it('creates, publishes and serves external https media exactly as written', async () => {
    expect(vars.MEDIA_ORIGIN).toBeUndefined();
    const p = product({ media: external });
    const [r] = await api.putProducts([p], { by });
    expect(r).toMatchObject({ status: 'created' });
    await settle();
    const published = await doc(p.key);
    expect(await srcs(p.key)).toEqual(external.map((m) => m.src));
    expect(published?.media).toMatchObject([{ alt: 'Front', width: 800 }, {}]);
  });

  it('refuses a bare key and an asset reference, at the path of each', async () => {
    const [bare, ref, ok] = await api.putProducts(
      [
        product({ media: [{ src: 'media/tee.jpg' }] }),
        product({ media: [{ src: 'asset:ast_1' }] }),
        product({ media: [{ src: 'https://cdn.merchant.example/a.jpg' }] }),
      ],
      { by },
    );
    expect(bare).toMatchObject({ status: 'rejected' });
    expect(bare?.status === 'rejected' && bare.issues).toEqual([
      { path: 'media.0.src', message: expect.stringMatching(/absolute https URL/) },
    ]);
    expect(ref?.issues?.[0]).toMatchObject({
      path: 'media.0.src',
      message: expect.stringMatching(/assets service/),
    });
    expect(ok).toMatchObject({ status: 'created' });
  });

  it('rejects a feed row with a bare key and imports the rest', async () => {
    const prefix = `med${Date.now().toString(36)}`;
    const csv = [
      'key,type,title:en,categories,price.web,sku,attr.material,attr.size,media',
      `${prefix}-a,apparel,A,tees,10,${prefix}-a-S,cotton,S,https://cdn.merchant.example/a.jpg`,
      `${prefix}-b,apparel,B,tees,10,${prefix}-b-S,cotton,S,media/b.jpg`,
    ].join('\r\n');
    const bytes = new TextEncoder().encode(csv);
    const started = await api.startFeed(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      { name: 'media.csv', format: 'csv', by },
    );
    let s: FeedStatus | null = null;
    for (let i = 0; i < 300; i++) {
      s = await api.feedStatus(started.id);
      if (s && !['queued', 'splitting', 'applying'].includes(s.state)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(s).toMatchObject({ state: 'done', rows: 2, created: 1, rejected: 1 });
    expect(s?.errors?.[0]?.message).toMatch(/media\.0\.src: must be an absolute https URL/);
  });
});

describe('product media with the assets service', () => {
  it('accepts an asset reference and publishes it as written (resolution is pending)', async () => {
    vars.MEDIA_ORIGIN = 'https://media.example.com';
    const p = product({ media: [{ src: 'asset:ast_1' }, external[0] as never] });
    const [r] = await api.putProducts([p], { by });
    expect(r).toMatchObject({ status: 'created' });
    await settle();
    expect(await srcs(p.key)).toEqual(['asset:ast_1', external[0]?.src]);
  });

  it('still refuses a bare key', async () => {
    vars.MEDIA_ORIGIN = 'https://media.example.com';
    const [r] = await api.putProducts([product({ media: [{ src: 'media/tee.jpg' }] })], { by });
    expect(r?.issues?.[0]?.message).toMatch(/asset:<assetId>/);
  });
});
