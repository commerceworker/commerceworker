import { describe, expect, it } from 'vitest';
import {
  CatalogEdgeError,
  type CatalogRpcLike,
  createCatalogEdgeReader,
} from '../../src/catalog-edge/index';

/** A stand-in for the `CATALOG_EDGE` binding: answers by path, and records what it was asked. */
function fakeEdge(answers: Record<string, Response | (() => Response)> = {}) {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      asked.push(`${url.pathname}${url.search}`);
      const answer = answers[`${url.pathname}${url.search}`];
      return answer instanceof Response
        ? answer.clone()
        : answer
          ? answer()
          : new Response('{}', { status: 404 });
    },
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const channels = [
  { code: 'b2b', currency: 'EUR', defaultLocale: 'de', locales: ['de'] },
  { code: 'web', currency: 'USD', defaultLocale: 'en', locales: ['en', 'es'] },
];
function fakeRpc(over: Partial<CatalogRpcLike> = {}) {
  const calls: string[] = [];
  const rpc: CatalogRpcLike = {
    ordersChannel: async () => (calls.push('ordersChannel'), 'web'),
    listChannels: async () => (calls.push('listChannels'), channels),
    listTypes: async (): ReturnType<CatalogRpcLike['listTypes']> => (
      calls.push('listTypes'),
      [
        {
          code: 'apparel',
          attributes: [
            { code: 'size', label: { en: 'Size', es: 'Talla' } },
            { code: 'color', label: { en: 'Color' } },
            { code: 'brand' },
          ],
          variantAxes: ['size', 'color'],
        },
      ]
    ),
    ...over,
  };
  return { rpc, calls };
}

describe('the catalog edge reader', () => {
  it('reads the orders channel from the catalog, kept for a while', async () => {
    const { rpc, calls } = fakeRpc();
    let t = 0;
    const reader = createCatalogEdgeReader({ edge: fakeEdge(), rpc, now: () => t });
    expect(await reader.channel()).toEqual(channels[1]);
    t = 29_000;
    await reader.channel();
    expect(calls).toEqual(['ordersChannel', 'listChannels']);
    t = 31_000;
    await reader.channel();
    expect(calls).toHaveLength(4);
  });

  it('has no channel while ORDERS_CHANNEL names one that does not exist', async () => {
    const { rpc } = fakeRpc({ ordersChannel: async () => 'ghost' });
    expect(await createCatalogEdgeReader({ edge: fakeEdge(), rpc }).channel()).toBeNull();
  });

  it('asks the edge for the canonical URL of a search, as its gateway forwards it', async () => {
    const edge = fakeEdge({
      '/v1/web/en/search?q=wool+hat': json({
        total: 2,
        next: null,
        products: [{ key: 'hat' }, { key: 'cap' }],
      }),
      '/v1/web/en/search?q=wool+hat&cursor=24&limit=5': json({
        total: 40,
        next: 29,
        partial: true,
        products: [{ key: 'x' }],
      }),
    });
    const reader = createCatalogEdgeReader({ edge, rpc: fakeRpc().rpc });
    // The edge's default page (24) and offset 0 are left out, so every ask is one cache entry.
    expect(await reader.search('web', 'en', 'wool hat', { limit: 24, offset: 0 })).toEqual({
      total: 2,
      keys: ['hat', 'cap'],
      next: null,
      partial: false,
    });
    expect(await reader.search('web', 'en', 'wool hat', { limit: 5, offset: 24 })).toEqual({
      total: 40,
      keys: ['x'],
      next: 29,
      partial: true,
    });
    expect(edge.asked).toEqual([
      '/v1/web/en/search?q=wool+hat',
      '/v1/web/en/search?q=wool+hat&cursor=24&limit=5',
    ]);
  });

  it('lists a category with its price range and cursor in the edge’s spelling', async () => {
    const edge = fakeEdge({
      '/v1/web/es/categories/apparel/products?r.price=1000..5000&cursor=1.0.0.0&limit=10': json({
        total: 3,
        next: '2.0.0.0',
        products: [{ key: 'tee' }],
      }),
      '/v1/web/es/categories/apparel/products?r.price=..5000': json({
        total: 1,
        next: null,
        products: [{ key: 'hat' }],
      }),
      '/v1/web/es/categories/apparel/products': json({ total: 0, next: null, products: [] }),
    });
    const reader = createCatalogEdgeReader({ edge, rpc: fakeRpc().rpc });
    expect(
      await reader.listing('web', 'es', 'apparel', {
        limit: 10,
        cursor: '1.0.0.0',
        price: { min: 1000, max: 5000 },
      }),
    ).toEqual({ total: 3, keys: ['tee'], next: '2.0.0.0' });
    expect(
      await reader.listing('web', 'es', 'apparel', { limit: 24, price: { max: 5000 } }),
    ).toMatchObject({ keys: ['hat'] });
    expect(await reader.listing('web', 'es', 'apparel', { limit: 24 })).toMatchObject({
      total: 0,
    });
    expect(edge.asked).toHaveLength(3);
  });

  it('reads a document by key and by SKU, and answers null for what is not published', async () => {
    const tee = { key: 'tee', title: 'Tee' };
    const edge = fakeEdge({
      '/v1/web/en/products/tee': json(tee),
      '/v1/web/en/skus/TEE-1': json(tee),
    });
    const reader = createCatalogEdgeReader({ edge, rpc: fakeRpc().rpc });
    expect(await reader.doc('web', 'en', 'tee')).toEqual(tee);
    expect(await reader.bySku('web', 'en', 'TEE-1')).toEqual(tee);
    expect(await reader.doc('web', 'en', 'ghost')).toBeNull();
    expect(await reader.listing('web', 'en', 'nowhere', { limit: 24 })).toBeNull();
    expect(await reader.search('web', 'en', 'x', { limit: 24, offset: 0 })).toMatchObject({
      keys: [],
    });
  });

  it('never sends a path, query or fragment of a caller’s as part of a route', async () => {
    const edge = fakeEdge();
    const reader = createCatalogEdgeReader({ edge, rpc: fakeRpc().rpc });
    await reader.doc('web', 'en', '../skus/x');
    await reader.bySku('web', 'en', 'a?b=c#d');
    await reader.listing('web', 'en', 'a/b', { limit: 24 });
    expect(edge.asked).toEqual([]);
    // A key that is a code goes out as the one path segment it is.
    await reader.doc('web', 'en', 'tee.v2_x-1');
    expect(edge.asked).toEqual(['/v1/web/en/products/tee.v2_x-1']);
  });

  it('does not ask for what is not a code, so a dot segment can never become another route', async () => {
    const edge = fakeEdge();
    const reader = createCatalogEdgeReader({ edge, rpc: fakeRpc().rpc });
    expect(await reader.doc('web', 'en', '..')).toBeNull();
    expect(await reader.doc('web', 'en', '.')).toBeNull();
    expect(await reader.bySku('web', 'en', '..')).toBeNull();
    expect(await reader.listing('web', 'en', '..', { limit: 24 })).toBeNull();
    expect(await reader.doc('..', 'en', 'tee')).toBeNull();
    expect(await reader.doc('web', '../x', 'tee')).toBeNull();
    expect(await reader.search('web', '..', 'tee', { limit: 24, offset: 0 })).toMatchObject({
      keys: [],
    });
    expect(edge.asked).toEqual([]);
  });

  it('fails loudly, and leaks nothing of the request, when the edge errors', async () => {
    const edge = fakeEdge({
      '/v1/web/en/products/tee': json({ error: 'boom' }, 503),
      '/v1/web/en/search?q=secret': json({ error: 'bad' }, 400),
    });
    const reader = createCatalogEdgeReader({ edge, rpc: fakeRpc().rpc });
    await expect(reader.doc('web', 'en', 'tee')).rejects.toBeInstanceOf(CatalogEdgeError);
    const err = await reader
      .search('web', 'en', 'secret', { limit: 24, offset: 0 })
      .catch((e: CatalogEdgeError) => e);
    expect(err).toMatchObject({ status: 400, message: 'catalog edge: search answered 400' });
    expect(String(err)).not.toContain('secret');
  });

  it('names a type’s option axes in the locale, falling back to what the type has', async () => {
    const { rpc, calls } = fakeRpc();
    const reader = createCatalogEdgeReader({ edge: fakeEdge(), rpc });
    expect(await reader.axisNames('apparel@3', 'es')).toEqual({ size: 'Talla', color: 'Color' });
    expect(await reader.axisNames('apparel@3', 'en-GB')).toEqual({ size: 'Size', color: 'Color' });
    expect(await reader.axisNames('unknown@1', 'en')).toEqual({});
    // One read of the types serves all three.
    expect(calls).toEqual(['listTypes']);
  });
});
