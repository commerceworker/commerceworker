import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { DOC_FORMAT, paths } from '@commerceworker/core/product/paths';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../../src';
import { CatalogDelivery, FRESH, MISSING } from '../../src/catalog/delivery';
import { backoff, drain, PURGE_CALLS, PURGE_PACE_MS } from '../../src/catalog/gateway';
import { CatalogRead } from '../../src/catalog/read';

const get = (path: string, init?: RequestInit) =>
  (exports as unknown as { default: Fetcher }).default.fetch(
    `https://catalog.example${path}`,
    init,
  );

const doc = (key: string, title: string) => JSON.stringify({ key, title, version: 1 });
const card = (key: string, title: string) => JSON.stringify({ key, title });

beforeAll(async () => {
  // What the catalog's publisher writes for two products and a category tree.
  const json = { httpMetadata: { contentType: 'application/json; charset=utf-8' } };
  await env.PUBLISHED.put(paths.doc(DOC_FORMAT, 'web', 'en', 'tee'), doc('tee', 'Tee'), json);
  await env.PUBLISHED.put(paths.doc(DOC_FORMAT, 'web', 'fr', 'tee'), doc('tee', 'T-shirt'), json);
  await env.PUBLISHED.put(paths.doc(DOC_FORMAT, 'web', 'en', 'hat'), doc('hat', 'Hat'), json);
  await env.PUBLISHED.put(
    paths.alias(DOC_FORMAT, 'web', 'sku:TEE-S'),
    JSON.stringify({ key: 'tee' }),
  );
  await env.PUBLISHED.put(
    paths.alias(DOC_FORMAT, 'web', 'slug:fr:t-shirt'),
    JSON.stringify({ key: 'tee' }),
  );
  await env.PUBLISHED.put(
    paths.alias(DOC_FORMAT, 'web', 'gtin:04006381333931'),
    JSON.stringify({ key: 'tee' }),
  );
  await env.PUBLISHED.put(paths.categories(DOC_FORMAT, 'web', 'en'), '{"categories":[]}', json);
  await env.CARDS.put(paths.uid(DOC_FORMAT, 'tee'), '7');
  await env.CARDS.put(paths.uid(DOC_FORMAT, 'hat'), '70');
  await env.CARDS.put(paths.card(DOC_FORMAT, 'web', 'en', 7), card('tee', 'Tee'));
  await env.CARDS.put(paths.card(DOC_FORMAT, 'web', 'en', 70), card('hat', 'Hat'));
});

describe('CatalogRead, what the engine binds', () => {
  const read = (path: string, init?: RequestInit) =>
    (exports as unknown as { CatalogRead: Fetcher }).CatalogRead.fetch(
      `https://catalog.internal${path}`,
      init,
    );

  it('serves the public routes as the gateway does, through the cached entry', async () => {
    const r = await read('/v1/web/en/products/tee');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ key: 'tee', title: 'Tee', version: 1 });
    expect((await read('/v1/web/en/skus/TEE-S')).status).toBe(200);
    expect((await read('/v1/web/en/products/ghost')).status).toBe(404);
  });

  it('refuses what is not a public read: index blobs, unknown paths, dot segments and writes', async () => {
    expect((await read('/_idx/web/shoes/0')).status).toBe(404);
    // A dot segment is resolved by URL parsing before the entrypoint sees it, into no route.
    expect((await read('/v1/web/en/products/..')).status).toBe(404);
    expect((await read('/nope')).status).toBe(404);
    const post = await read('/v1/web/en/products/tee', { method: 'POST', body: '{}' });
    expect(post.status).toBe(405);
  });

  it('has only fetch: no purge or other method a service binding could call', () => {
    expect(Object.getOwnPropertyNames(CatalogRead.prototype).sort()).toEqual([
      'constructor',
      'fetch',
    ]);
  });
});

describe('documents', () => {
  it('serves external media URLs exactly as the catalog published them, with no media service bound', async () => {
    // A deployment without the assets service: the catalog accepts only absolute https media
    // (apps/catalog/tests/media.test.ts), and this Worker has no media binding or origin.
    const media = [{ src: 'https://cdn.merchant.example/tee front.jpg?v=3', alt: 'Front' }];
    const body = JSON.stringify({ key: 'media-tee', title: 'Tee', version: 1, media });
    await env.PUBLISHED.put(paths.doc(DOC_FORMAT, 'web', 'en', 'media-tee'), body, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    const r = await get('/v1/web/en/products/media-tee');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(body);
  });

  it('serves a product document with its ETag, freshness and tags', async () => {
    const r = await get('/v1/web/fr/products/tee');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ key: 'tee', title: 'T-shirt', version: 1 });
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe(FRESH);
    expect(r.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('answers 304 when the ETag still matches, which is how the cache revalidates', async () => {
    const etag = (await get('/v1/web/en/products/tee')).headers.get('etag') ?? '';
    const r = await get('/v1/web/en/products/tee', { headers: { 'if-none-match': etag } });
    expect(r.status).toBe(304);
    expect(r.headers.get('etag')).toBe(etag);
    expect(await r.text()).toBe('');
    expect(
      (await get('/v1/web/en/products/tee', { headers: { 'if-none-match': '"other"' } })).status,
    ).toBe(200);
  });

  it('finds a product by SKU and by slug', async () => {
    expect(await (await get('/v1/web/en/skus/TEE-S')).json()).toMatchObject({ title: 'Tee' });
    expect(await (await get('/v1/web/fr/slugs/t-shirt')).json()).toMatchObject({
      title: 'T-shirt',
    });
    const none = await get('/v1/web/en/skus/NOPE');
    expect(none.status).toBe(404);
    expect(none.headers.get('cache-control')).toBe(MISSING);
  });

  it('finds a product by GTIN-14, and a GTIN nobody holds is a brief miss', async () => {
    expect(await (await get('/v1/web/en/gtins/04006381333931')).json()).toMatchObject({
      title: 'Tee',
    });
    const none = await get('/v1/web/en/gtins/04006381333932');
    expect(none.status).toBe(404);
    expect(none.headers.get('cache-control')).toBe(MISSING);
  });

  it('remembers a missing product only briefly', async () => {
    const r = await get('/v1/web/en/products/nope');
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe(MISSING);
  });

  it('serves the category tree', async () => {
    const r = await get('/v1/web/en/categories');
    expect(await r.json()).toEqual({ categories: [] });
    expect(r.headers.get('etag')).toBeTruthy();
  });

  it('answers HEAD without a body', async () => {
    const r = await get('/v1/web/en/products/tee', { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBeTruthy();
    expect(await r.text()).toBe('');
  });
});

describe('batches', () => {
  it('returns cards in the order asked, null for unknown keys, duplicates once', async () => {
    const r = await get('/v1/web/en/products?keys=hat,nope,tee,hat');
    expect(await r.json()).toEqual({
      products: [{ key: 'hat', title: 'Hat' }, null, { key: 'tee', title: 'Tee' }],
    });
    expect(r.headers.get('cache-control')).toBe(FRESH);
  });

  it('tags a batch with an ETag of its body and answers 304 when it still matches', async () => {
    const r = await get('/v1/web/en/products?keys=tee,hat');
    const etag = r.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await get('/v1/web/en/products?keys=tee,hat', {
      headers: { 'if-none-match': `W/${etag}` },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
    expect(again.headers.get('cache-control')).toBe(FRESH);
    expect(await again.text()).toBe('');
    const other = await get('/v1/web/en/products?keys=hat,tee');
    expect(other.headers.get('etag')).not.toBe(etag);
  });

  it('finds a product again whose uid changed (deleted and created anew)', async () => {
    await env.CARDS.put(paths.uid(DOC_FORMAT, 'cap'), '80');
    await env.CARDS.put(paths.card(DOC_FORMAT, 'web', 'en', 80), card('cap', 'Cap'));
    expect(await (await get('/v1/web/en/products?keys=cap')).json()).toEqual({
      products: [{ key: 'cap', title: 'Cap' }],
    });
    // What the publisher leaves after a delete and a new create: a new uid, the old card gone.
    await env.CARDS.delete(paths.card(DOC_FORMAT, 'web', 'en', 80));
    await env.CARDS.put(paths.uid(DOC_FORMAT, 'cap'), '81');
    await env.CARDS.put(paths.card(DOC_FORMAT, 'web', 'en', 81), card('cap', 'New cap'));
    expect(await (await get('/v1/web/en/products?keys=cap')).json()).toEqual({
      products: [{ key: 'cap', title: 'New cap' }],
    });
  });

  describe('when KV fails', () => {
    // The entrypoint with the cards namespace as a stub, the rest of the bindings real.
    const edge = (cards: Partial<KVNamespace>, points: unknown[] = []) =>
      new CatalogDelivery({} as ExecutionContext, {
        PUBLISHED: env.PUBLISHED,
        CATALOG: env.CATALOG,
        CARDS: cards as KVNamespace,
        ANALYTICS: { writeDataPoint: (p: unknown) => points.push(p) } as AnalyticsEngineDataset,
      });
    const batch = (e: CatalogDelivery, keys: string) =>
      e.fetch(new Request(`https://catalog.internal/v1/web/en/products?keys=${keys}`));
    const down = {
      get: async () => {
        throw new Error('KV GET failed: 500');
      },
    };

    it('answers a batch from the published documents, counts it, and keeps it only briefly', async () => {
      const points: unknown[] = [];
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const r = await batch(edge(down, points), 'hat,nope,tee');
      expect(r.status).toBe(200);
      // A card made from each document (its attributes the one thing a document can't say), null for a key with none.
      expect(await r.json()).toEqual({
        products: [
          { key: 'hat', version: 1, title: 'Hat', variants: 0, attributes: {} },
          null,
          { key: 'tee', version: 1, title: 'Tee', variants: 0, attributes: {} },
        ],
      });
      expect(r.headers.get('cache-control')).toBe(MISSING);
      expect(points).toEqual([
        {
          indexes: ['failover'],
          blobs: ['failover', 'catalog-edge', 'cards_kv_read', ''],
          doubles: [1, 0],
        },
      ]);
      expect(log).toHaveBeenCalledWith(
        'catalog edge failover',
        expect.stringContaining('KV GET failed: 500'),
      );
      log.mockRestore();
    });

    it('builds the card a listing shows from the whole document', async () => {
      await env.PUBLISHED.put(
        paths.doc(DOC_FORMAT, 'web', 'en', 'jacket'),
        JSON.stringify({
          key: 'jacket',
          version: 3,
          title: 'Jacket',
          slug: 'jacket',
          brand: 'Acme',
          media: [{ src: '/a.jpg', alt: 'Front', width: 800, height: 600 }, { src: '/b.jpg' }],
          attributes: { color: 'red' },
          variants: [{ sku: 'J-S' }, { sku: 'J-M' }],
          price: { amount: 9900, currency: 'USD' },
          priceRange: {
            min: { amount: 9900, currency: 'USD' },
            max: { amount: 12900, currency: 'USD' },
          },
        }),
      );
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const body = (await (await batch(edge(down), 'jacket')).json()) as { products: unknown[] };
      expect(body.products).toEqual([
        {
          key: 'jacket',
          version: 3,
          title: 'Jacket',
          slug: 'jacket',
          brand: 'Acme',
          image: { src: '/a.jpg', alt: 'Front', width: 800, height: 600 },
          price: { amount: 9900, currency: 'USD' },
          priceRange: {
            min: { amount: 9900, currency: 'USD' },
            max: { amount: 12900, currency: 'USD' },
          },
          variants: 2,
          attributes: {},
        },
      ]);
      log.mockRestore();
    });

    it('does not fall back for a miss: an unknown key stays null, at the normal freshness', async () => {
      const points: unknown[] = [];
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      // KV answers, with nothing for these keys; a document sits in R2 for `tee` all the same.
      const r = await batch(edge({ get: async () => new Map() as never }, points), 'tee,ghost');
      expect(await r.json()).toEqual({ products: [null, null] });
      expect(r.headers.get('cache-control')).toBe(FRESH);
      expect(points).toEqual([]);
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    });
  });

  it('refuses a batch without keys, with too many, or with a bad one', async () => {
    expect((await get('/v1/web/en/products')).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `k${i}`).join(',');
    expect(await (await get(`/v1/web/en/products?keys=${many}`)).json()).toEqual({
      error: 'at most 100 keys',
    });
    expect((await get('/v1/web/en/products?keys=ok,bad%20key')).status).toBe(400);
  });
});

describe('the gateway', () => {
  it('refuses writes and answers preflights', async () => {
    expect((await get('/v1/web/en/products/tee', { method: 'POST' })).status).toBe(405);
    const pre = await get('/v1/web/en/products/tee', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toBe('if-none-match');
  });

  it('refuses malformed routes before they reach the cache', async () => {
    expect((await get('/v2/web/en/products/tee')).status).toBe(404);
    expect((await get('/v1/we%20b/en/products/tee')).status).toBe(400);
    expect((await get('/v1/web/EN_us/products/tee')).status).toBe(400);
    expect((await get('/v1/web/en/slugs/Not-A-Slug')).status).toBe(400);
    // Only the GTIN-14 the catalog claims: a UPC or EAN is padded by the caller, so one item is one URL.
    for (const g of ['4006381333931', '0400638133393a', '004006381333931'])
      expect((await get(`/v1/web/en/gtins/${g}`)).status).toBe(400);
    expect((await get('/v1/web/en/widgets')).status).toBe(404);
    expect(await (await get('/health')).json()).toEqual({ ok: true });
  });
});

describe('purging', () => {
  it('acknowledges a purge batch (no Workers Caching locally, so nothing to purge)', async () => {
    const batch = createMessageBatch('commerceworker-catalog-purge', [
      { id: 'a', timestamp: new Date(), attempts: 1, body: { tags: ['p:tee'] } },
      { id: 'b', timestamp: new Date(), attempts: 1, body: { tags: ['p:tee', 'p:hat'] } },
    ]);
    const ctx = Object.assign(createExecutionContext(), { exports });
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(['a', 'b']);
    expect(result.retryMessages).toEqual([]);
    expect(result.retryBatch.retry).toBe(false);
  });

  // A clock that the pacing advances, so 12-second waits take no time.
  const clock = (start: number) => {
    const c = { now: start, waits: [] as number[] };
    return {
      c,
      wait: async (ms: number) => {
        c.waits.push(ms);
        c.now += ms;
      },
      now: () => c.now,
    };
  };
  const tagsFor = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `p:${prefix}${i}`);
  const run = async (
    messages: { id: string; age: number; tags: string[]; attempts?: number }[],
    refuseCall?: number,
  ) => {
    const start = Date.UTC(2026, 9, 1);
    const t = clock(start);
    const batch = createMessageBatch(
      'commerceworker-catalog-purge',
      messages.map((m) => ({
        id: m.id,
        timestamp: new Date(start - m.age),
        attempts: m.attempts ?? 1,
        body: { tags: m.tags },
      })),
    );
    // The local queue records which messages were retried but not their delay, so note it here.
    const delays: Record<string, number | undefined> = {};
    for (const m of batch.messages) {
      const retry = m.retry.bind(m);
      vi.spyOn(m, 'retry').mockImplementation((o) => {
        delays[m.id] = o?.delaySeconds;
        retry(o);
      });
    }
    const calls: string[][] = [];
    await drain(
      batch,
      async (tags) => {
        calls.push(tags);
        return { success: calls.length !== refuseCall };
      },
      t.wait,
    );
    const ctx = createExecutionContext();
    return { calls, waits: t.c.waits, delays, result: await getQueueResult(batch, ctx) };
  };

  it('packs whole messages into calls of up to 100 tags, one call every 12 seconds', async () => {
    const { calls, waits, result } = await run([
      { id: 'a', age: 0, tags: tagsFor('a', 60) },
      { id: 'b', age: 0, tags: tagsFor('b', 60) },
      { id: 'c', age: 0, tags: [...tagsFor('c', 30), 'p:a0'] },
      { id: 'd', age: 0, tags: tagsFor('d', 250) },
    ]);
    expect(calls.map((c) => c.length)).toEqual([60, 90, 100, 100, 50]);
    expect(calls[1]).not.toContain('p:a0');
    expect(waits).toEqual(Array(5).fill(PURGE_PACE_MS));
    expect(result.explicitAcks.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(result.retryMessages).toEqual([]);
  });

  it('purges an old message too, and hands back what is past the per-batch call cap', async () => {
    const { calls, delays, result } = await run([
      { id: 'old', age: 3_600_000, tags: ['p:old'] },
      ...Array.from({ length: PURGE_CALLS + 5 }, (_, i) => ({
        id: `m${i}`,
        age: 0,
        tags: tagsFor(`m${i}-`, 100),
      })),
    ]);
    // Stale-while-revalidate keeps an old copy servable, so an hour-old purge still goes out.
    expect(calls[0]).toContain('p:old');
    expect(calls).toHaveLength(PURGE_CALLS);
    expect(result.retryMessages).toHaveLength(6);
    // The old message alone (it and a 100-tag one exceed a call), then 39 of the rest.
    expect(result.explicitAcks).toHaveLength(PURGE_CALLS);
    // Handed back after one pace interval, not at once.
    expect(Object.values(delays)).toEqual(Array(6).fill(12));
  });

  it('backs off a message handed back again, up to five minutes', async () => {
    const { delays } = await run([
      ...Array.from({ length: PURGE_CALLS }, (_, i) => ({
        id: `m${i}`,
        age: 1000,
        tags: tagsFor(`m${i}-`, 100),
      })),
      { id: 'late', age: 0, tags: ['p:late'], attempts: 4 },
      { id: 'later', age: 0, tags: ['p:later'], attempts: 9 },
    ]);
    expect(delays).toEqual({ late: 96, later: 300 });
  });

  it('retries what a refused call left, keeping what was purged acknowledged', async () => {
    const { calls, delays, result } = await run(
      [
        { id: 'a', age: 0, tags: tagsFor('a', 100) },
        { id: 'b', age: 0, tags: tagsFor('b', 100) },
        { id: 'c', age: 0, tags: tagsFor('c', 100) },
      ],
      2,
    );
    expect(calls).toHaveLength(2);
    expect(result.explicitAcks).toEqual(['a']);
    expect(result.retryMessages.map((m) => m.msgId).sort()).toEqual(['b', 'c']);
    // Once the ration refills: 30 seconds on a first delivery.
    expect(delays).toEqual({ b: 30, c: 30 });
  });

  it('doubles the wait for a refused purge with each delivery, up to 15 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map((a) => backoff(a, 30, 900))).toEqual([
      30, 60, 120, 240, 480, 900, 900,
    ]);
  });
});
