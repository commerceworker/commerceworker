import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CatalogClient,
  CatalogConnectionError,
  CatalogError,
  CatalogNotFoundError,
  CatalogRateLimitError,
  CatalogTimeoutError,
  createCatalogClient,
  isCatalogApiError,
  isCatalogConnectionError,
  isCatalogError,
  type ListingPage,
  type SearchPage,
} from '../src/index';

const ORIGIN = 'https://catalog.example.com';
const BASE = `${ORIGIN}/v1/web/en`;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

type Call = { url: string; init: RequestInit | undefined };

function setup(
  answer: (call: Call, n: number) => Response | Promise<Response>,
  extra: Partial<Parameters<typeof createCatalogClient>[0]> = {},
) {
  const calls: Call[] = [];
  const client = createCatalogClient({
    origin: `${ORIGIN}/`,
    channel: 'web',
    locale: 'en',
    maxRetries: 2,
    fetch: (async (url: string, init?: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return answer(call, calls.length);
    }) as typeof fetch,
    ...extra,
  });
  return { client, calls };
}

// Retry waits are full-jittered: with no jitter they are instant.
afterEach(() => vi.restoreAllMocks());
const noWait = () => vi.spyOn(Math, 'random').mockReturnValue(0);

describe('reads', () => {
  it('each route is one GET to its canonical url, with no headers', async () => {
    const { client, calls } = setup(() => json({ ok: true }));
    await client.product('tee-1');
    await client.products(['a', 'b']);
    await client.sku('SKU-1');
    await client.slug('blue-tee');
    await client.categories();
    await client.listing('shirts', {
      filters: { size: ['m', 'l'] },
      ranges: { price: { min: 100 } },
      sort: 'price_asc',
      limit: 10,
    });
    await client.search('Blue Tee', { cursor: 24 });
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/products/tee-1`,
      `${BASE}/products?keys=a,b`,
      `${BASE}/skus/SKU-1`,
      `${BASE}/slugs/blue-tee`,
      `${BASE}/categories`,
      `${BASE}/categories/shirts/products?f.size=l%2Cm&r.price=100..&sort=price_asc&limit=10`,
      `${BASE}/search?q=blue+tee&cursor=24`,
    ]);
    for (const c of calls) {
      expect(c.init?.method).toBe('GET');
      // Headers would turn a browser's simple request into a preflighted one.
      expect(c.init?.headers).toBeUndefined();
    }
  });

  it('returns the parsed body', async () => {
    const { client } = setup(() => json({ products: [{ key: 'a' }, null] }));
    expect(await client.products(['a', 'gone'])).toEqual({ products: [{ key: 'a' }, null] });
  });

  it('refuses a bad request without sending it', async () => {
    const { client, calls } = setup(() => json({}));
    await expect(client.product('no good')).rejects.toBeInstanceOf(TypeError);
    await expect(client.search('!!')).rejects.toThrow('q needs a word');
    await expect(client.listing('c', { sort: 'cheapest' })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a bad channel or locale at construction', () => {
    const make = (channel: string, locale: string) => () =>
      createCatalogClient({ origin: ORIGIN, channel, locale });
    expect(make('we b', 'en')).toThrow('bad channel');
    expect(make('web', 'EN')).toThrow('bad locale');
    expect(make('web', 'zh-Hant-TW')).not.toThrow();
  });
});

describe('paging', () => {
  const card = (key: string) => ({ key, title: key, version: 1, variants: 1, attributes: {} });
  const listingPage = (keys: string[], next: string | null): ListingPage => ({
    total: 5,
    next,
    sorts: ['newest'],
    products: keys.map(card),
    facets: {},
    ranges: {},
  });

  it('listingPages follows next, passing it back exactly as it came', async () => {
    const pages: Record<string, ListingPage> = {
      '': listingPage(['a', 'b'], '2.0.0.0.0.0.0.0'),
      '2.0.0.0.0.0.0.0': listingPage(['c', 'd'], '4.0.0.0.0.0.0.0'),
      '4.0.0.0.0.0.0.0': listingPage(['e'], null),
    };
    const { client, calls } = setup(({ url }) =>
      json(pages[new URL(url).searchParams.get('cursor') ?? '']),
    );
    const keys: string[] = [];
    for await (const page of client.listingPages('shirts', { limit: 2, sort: 'price_asc' }))
      keys.push(...page.products.map((p) => p.key));
    expect(keys).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/categories/shirts/products?sort=price_asc&limit=2`,
      `${BASE}/categories/shirts/products?sort=price_asc&cursor=2.0.0.0.0.0.0.0&limit=2`,
      `${BASE}/categories/shirts/products?sort=price_asc&cursor=4.0.0.0.0.0.0.0&limit=2`,
    ]);
  });

  it('listingPages stops at a cursor the server repeats', async () => {
    const { client, calls } = setup(() => json(listingPage(['a'], '1.0.0.0.0.0.0.0')));
    const seen: ListingPage[] = [];
    for await (const page of client.listingPages('shirts', { cursor: '1.0.0.0.0.0.0.0' }))
      seen.push(page);
    expect(seen).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('stops pulling pages when the loop breaks', async () => {
    const { client, calls } = setup(() => json(listingPage(['a'], '1.0.0.0.0.0.0.0')));
    for await (const _page of client.listingPages('shirts')) break;
    expect(calls).toHaveLength(1);
  });

  it('searchPages follows the numeric next to the end', async () => {
    const answers: SearchPage[] = [
      { total: 3, next: 2, products: [card('a'), card('b')] },
      { total: 3, next: null, products: [card('c')] },
    ];
    const { client, calls } = setup((_c, n) => json(answers[n - 1]));
    const keys: string[] = [];
    for await (const page of client.searchPages('tee', { limit: 2 }))
      keys.push(...page.products.map((p) => p.key));
    expect(keys).toEqual(['a', 'b', 'c']);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/search?q=tee&limit=2`,
      `${BASE}/search?q=tee&cursor=2&limit=2`,
    ]);
  });

  it('searchPages does not loop on a next that does not advance', async () => {
    const { client, calls } = setup(() => json({ total: 9, next: 0, products: [] }));
    for await (const _page of client.searchPages('tee')) {
    }
    expect(calls).toHaveLength(1);
  });
});

describe('errors', () => {
  it('a 404 is a CatalogNotFoundError with the edge’s message and the ray id', async () => {
    const { client, calls } = setup(() =>
      json({ error: 'not found' }, { status: 404, headers: { 'cf-ray': 'abc-LHR' } }),
    );
    const err = await client.product('gone').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CatalogNotFoundError);
    expect(isCatalogApiError(err, 'not_found')).toBe(true);
    expect(isCatalogApiError(err, 'server')).toBe(false);
    expect(err).toMatchObject({
      name: 'CatalogNotFoundError',
      status: 404,
      kind: 'not_found',
      message: 'not found',
      requestId: 'abc-LHR',
      body: { error: 'not found' },
    });
    // Not retried: nothing published won't be published by asking again.
    expect(calls).toHaveLength(1);
  });

  it('a 400 keeps the edge’s body (the sorts a category has)', async () => {
    const { client } = setup(() =>
      json({ error: 'unsupported sort', sorts: ['newest', 'price_asc'] }, { status: 400 }),
    );
    const err = await client.listing('shirts', { sort: 'weight_asc' }).catch((e: unknown) => e);
    expect(isCatalogApiError(err, 'bad_request')).toBe(true);
    expect((err as { body: { sorts: string[] } }).body.sorts).toEqual(['newest', 'price_asc']);
  });

  it('a body that is not JSON is the message', async () => {
    const { client } = setup(() => new Response('upstream gone', { status: 502 }), {
      maxRetries: 0,
    });
    await expect(client.categories()).rejects.toMatchObject({
      status: 502,
      message: 'upstream gone',
    });
  });

  it('guards narrow across copies of the package by brand, not by class', () => {
    const lookalike = Object.assign(new Error('x'), {
      [Symbol.for('commerceworker.catalog.error')]: true,
    });
    expect(isCatalogError(lookalike)).toBe(true);
    expect(isCatalogError(new Error('x'))).toBe(false);
    expect(isCatalogError(null)).toBe(false);
    expect(isCatalogApiError(new CatalogError('x', 'server'))).toBe(false);
    expect(isCatalogConnectionError(new CatalogTimeoutError('t', {}))).toBe(true);
    // The commerce client's brand is a different one.
    expect(
      isCatalogError(
        Object.assign(new Error('x'), { [Symbol.for('commerceworker.commerce.error')]: true }),
      ),
    ).toBe(false);
  });
});

describe('retries', () => {
  it('retries a 503 (a listing rebuilding) and a 429 until one answers', async () => {
    noWait();
    const { client, calls } = setup((_c, n) =>
      n === 1
        ? json({ error: 'listing rebuilding' }, { status: 503 })
        : n === 2
          ? json({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '0' } })
          : json({ categories: [] }),
    );
    expect(await client.categories()).toEqual({ categories: [] });
    expect(calls).toHaveLength(3);
  });

  it('every route retries: they are all GETs', async () => {
    noWait();
    for (const call of [
      (c: CatalogClient) => c.product('a'),
      (c: CatalogClient) => c.products(['a']),
      (c: CatalogClient) => c.sku('a'),
      (c: CatalogClient) => c.slug('a'),
      (c: CatalogClient) => c.listing('a'),
      (c: CatalogClient) => c.search('a'),
    ]) {
      const { client, calls } = setup((_c, n) => (n === 1 ? json({}, { status: 500 }) : json({})));
      await call(client);
      expect(calls).toHaveLength(2);
    }
  });

  it('gives up after maxRetries and throws the last failure', async () => {
    noWait();
    const { client, calls } = setup(() => json({ error: 'boom' }, { status: 500 }), {
      maxRetries: 1,
    });
    await expect(client.categories()).rejects.toMatchObject({ status: 500, kind: 'server' });
    expect(calls).toHaveLength(2);
  });

  it('maxRetries 0, per client or per call, sends once', async () => {
    const a = setup(() => json({}, { status: 500 }), { maxRetries: 0 });
    await expect(a.client.categories()).rejects.toMatchObject({ status: 500 });
    expect(a.calls).toHaveLength(1);
    const b = setup(() => json({}, { status: 500 }));
    await expect(b.client.categories({ maxRetries: 0 })).rejects.toMatchObject({ status: 500 });
    expect(b.calls).toHaveLength(1);
  });

  it('honors Retry-After, and throws rather than wait over a minute', async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = setup((_c, n) =>
        n === 1 ? json({}, { status: 429, headers: { 'retry-after': '5' } }) : json({ ok: 1 }),
      );
      const done = client.categories();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await done).toEqual({ ok: 1 });
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
    const long = setup(() => json({}, { status: 429, headers: { 'retry-after': '3600' } }));
    const err = await long.client.categories().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CatalogRateLimitError);
    expect((err as CatalogRateLimitError).retryAfterSec).toBe(3600);
    expect(long.calls).toHaveLength(1);
  });

  it('retries a dropped connection and wraps the last one, keeping its cause', async () => {
    noWait();
    const cause = new TypeError('fetch failed');
    const { client, calls } = setup(() => {
      throw cause;
    });
    const err = await client.product('a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CatalogConnectionError);
    expect(isCatalogConnectionError(err)).toBe(true);
    expect(err).toMatchObject({ kind: 'connection', cause });
    expect(calls).toHaveLength(3);
  });

  it('a timeout is a CatalogTimeoutError, retried like a connection error', async () => {
    noWait();
    const { client, calls } = setup(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { timeoutMs: 5, maxRetries: 1 },
    );
    const err = await client.product('a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CatalogTimeoutError);
    expect(err).toMatchObject({ kind: 'timeout' });
    expect(isCatalogConnectionError(err)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('a caller’s abort is thrown as it is and not retried', async () => {
    const controller = new AbortController();
    const { client, calls } = setup(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const pending = client.product('a', { signal: controller.signal });
    const reason = new Error('navigated away');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
  });
});
