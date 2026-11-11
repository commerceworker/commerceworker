import { env, withEnv } from 'cloudflare:workers';
import { Validator } from '@cfworker/json-schema';
import {
  CATALOG_LOOKUP_CAPABILITY,
  CATALOG_SEARCH_CAPABILITY,
  CHECKOUT_CAPABILITY,
  type PlatformCaller,
  PRINCIPAL_HEADER,
  signPlatform,
  UCP_VERSION,
} from '@commerceworker/core';
import {
  decodeListingCursor,
  encodeListingCursor,
  LISTING_SEGMENTS,
  type ProductDoc,
} from '@commerceworker/core/product';
import { checkoutSessions } from '@commerceworker/db';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mcpSpec from '../../../packages/core/tests/fixtures/ucp/services/shopping/mcp.openrpc.json';
import worker from '../src/index';
import { ucpStore } from '../src/wire';
import { db, enableUcp, key, platform, platformKey, ucp } from './ucp-helpers';

// The published schemas, to check what is served against (vendored unchanged).
const schemas = Object.values(
  (import.meta as unknown as { glob(p: string, o: object): Record<string, { $id: string }> }).glob(
    '../../../packages/core/tests/fixtures/ucp/schemas/**/*.json',
    { eager: true, import: 'default' },
  ),
);
function conformsTo(ref: string, value: unknown) {
  const v = new Validator({ $ref: `https://ucp.dev/schemas/${ref}` }, '2020-12', false);
  for (const s of schemas) v.addSchema(s as never, s.$id);
  const r = v.validate(value);
  return r.valid ? [] : r.errors.map((e) => `${e.instanceLocation}: ${e.error}`);
}
const SEARCH = 'shopping/catalog_search.json#/$defs/search_response';
const LOOKUP = 'shopping/catalog_lookup.json#/$defs/lookup_response';
const PRODUCT = 'shopping/catalog_lookup.json#/$defs/get_product_response';
const ERROR = 'common/types/error_response.json';

// ── The catalog, as the edge would publish it ─────────────────────────────

const usd = (amount: number) => ({ amount, currency: 'USD' });
const doc = (over: Partial<ProductDoc> & { key: string }): ProductDoc => ({
  type: 'apparel@1',
  version: 1,
  updatedAt: 1,
  title: over.key,
  slug: over.key,
  description: `About ${over.key}`,
  categories: ['apparel'],
  media: [],
  attributes: {},
  variants: [],
  ...over,
});
const tee = (title: string, size: string[]): ProductDoc =>
  doc({
    key: 'tee',
    title,
    description: 'Soft and plain.',
    brand: 'Acme',
    media: [
      { src: 'https://cdn.example/tee.jpg', alt: 'A tee', width: 800, height: 600 },
      { src: 'asset:ast_123' },
    ],
    // What a platform must never see: the supplier and cost the document carries for the admin.
    attributes: { material: 'cotton', internal_notes: 'margin is 60%' },
    extra: { costCents: 123, supplier: 'Acme Mills' },
    variants: [
      {
        sku: 'TEE-S',
        status: 'active',
        options: { size: { code: 's', label: size[0] as string } },
        attributes: {},
        price: usd(1800),
      },
      {
        sku: 'TEE-L',
        status: 'active',
        options: { size: { code: 'l', label: size[1] as string } },
        attributes: {},
        price: usd(2200),
      },
    ],
    priceRange: { min: usd(1800), max: usd(2200) },
    compareAt: usd(2500),
  });
const one = (key: string, title: string, categories: string[], sku: string, price: object) =>
  doc({
    key,
    title,
    categories,
    variants: [
      { sku, status: 'active', options: {}, attributes: {}, price: price as ProductDoc['price'] },
    ],
  });

const DOCS: Record<string, ProductDoc[]> = {
  en: [
    tee('Cotton tee', ['Small', 'Large']),
    one('hat', 'Wool hat', ['accessories'], 'HAT-1', usd(4000)),
    one('mug', 'Cotton mug', ['home'], 'MUG-1', usd(900)),
    one('scarf', 'Cotton scarf', ['apparel'], 'SCARF-1', { amount: 3000, currency: 'EUR' }),
  ],
  es: [tee('Camiseta de algodon', ['Pequena', 'Grande'])],
};
/** Another channel's product: nothing here may reach a platform. */
const OTHER_CHANNEL = [one('secret-b2b', 'Cotton wholesale', ['apparel'], 'B2B-1', usd(1))];

/** The read edge: the published routes, answering from DOCS. `asked` is every request it saw. */
function fakeEdge() {
  const asked: string[] = [];
  let fail = false;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  return {
    asked,
    failWith503: (on = true) => {
      fail = on;
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      asked.push(`${url.pathname}${url.search}`);
      if (fail) return json({ error: 'down' }, 503);
      const [, , channel, locale, kind, ...rest] = url.pathname.split('/');
      const docs =
        channel === 'web' ? (DOCS[locale ?? ''] ?? []) : channel === 'b2b' ? OTHER_CHANNEL : [];
      const card = (d: ProductDoc) => ({ key: d.key, title: d.title });
      const limit = Number(url.searchParams.get('limit') ?? 24);
      if (kind === 'products' && rest[0]) {
        const d = docs.find((x) => x.key === decodeURIComponent(rest[0] as string));
        return d ? json(d) : json({ error: 'no such product' }, 404);
      }
      if (kind === 'skus' && rest[0]) {
        const d = docs.find((x) =>
          x.variants.some((v) => v.sku === decodeURIComponent(rest[0] as string)),
        );
        return d ? json(d) : json({ error: 'no product for sku' }, 404);
      }
      if (kind === 'search') {
        const terms = (url.searchParams.get('q') ?? '').split(' ').filter(Boolean);
        const hits = docs.filter((d) =>
          terms.every((t) => `${d.title} ${d.description}`.toLowerCase().includes(t)),
        );
        const offset = Number(url.searchParams.get('cursor') ?? 0);
        const end = offset + limit;
        return json({
          total: hits.length,
          next: end < hits.length ? end : null,
          products: hits.slice(offset, end).map(card),
        });
      }
      if (kind === 'categories' && rest[1] === 'products') {
        const [lo, hi] = (url.searchParams.get('r.price') ?? '..').split('..');
        const members = docs.filter(
          (d) =>
            d.categories.includes(rest[0] as string) &&
            d.variants.some(
              (v) =>
                (v.price?.amount ?? 0) >= Number(lo || 0) &&
                (v.price?.amount ?? 0) <= Number(hi || Number.MAX_SAFE_INTEGER),
            ),
        );
        if (!docs.some((d) => d.categories.includes(rest[0] as string)))
          return json({ error: 'no such category' }, 404);
        const cursor = url.searchParams.get('cursor');
        const start = cursor ? (decodeListingCursor(cursor)?.[0] ?? 0) : 0;
        const end = start + limit;
        return json({
          total: members.length,
          next:
            end < members.length
              ? encodeListingCursor([end, ...Array(LISTING_SEGMENTS - 1).fill(0)])
              : null,
          products: members.slice(start, end).map(card),
        });
      }
      return json({ error: 'not found' }, 404);
    },
  };
}

/** The catalog's RPC: the orders channel (`web`, USD) beside another the edge must never be asked for. */
const rpc = {
  ordersChannel: async () => 'web',
  listChannels: async () => [
    { code: 'b2b', name: 'B2B', currency: 'USD', defaultLocale: 'en', locales: ['en'] },
    { code: 'web', name: 'Web', currency: 'USD', defaultLocale: 'en', locales: ['en', 'es'] },
  ],
  listTypes: async () => [
    {
      code: 'apparel',
      version: 1,
      attributes: [{ code: 'size', label: { en: 'Size', es: 'Talla' } }],
      variantAxes: ['size'],
    },
  ],
};

// ── Platforms ─────────────────────────────────────────────────────────────

const entry = (name: string) => ({
  version: UCP_VERSION,
  spec: `https://ucp.dev/${UCP_VERSION}/specification/${name}`,
  schema: `https://ucp.dev/${UCP_VERSION}/schemas/${name}.json`,
});
const profileWith = (...caps: string[]) => ({
  ucp: {
    version: UCP_VERSION,
    services: {},
    payment_handlers: {},
    capabilities: Object.fromEntries(
      [CHECKOUT_CAPABILITY, ...caps].map((c) => [
        c,
        [entry(c.replace('dev.ucp.', '').replaceAll('.', '/'))],
      ]),
    ),
  },
});

let shopper: PlatformCaller;
let searchOnly: PlatformCaller;
let checkoutOnly: PlatformCaller;
beforeAll(async () => {
  await enableUcp();
  shopper = await platform(
    'shopper',
    profileWith(CATALOG_SEARCH_CAPABILITY, CATALOG_LOOKUP_CAPABILITY),
  );
  searchOnly = await platform('searcher', profileWith(CATALOG_SEARCH_CAPABILITY));
  checkoutOnly = await platform('buyer_only', profileWith());
});
afterEach(() => vi.restoreAllMocks());

/** Runs `fn` against a fresh fake edge, as the Worker's own bindings. */
async function onEdge<T>(fn: (edge: ReturnType<typeof fakeEdge>) => Promise<T>): Promise<T> {
  const edge = fakeEdge();
  return (await withEnv({ ...env, CATALOG: rpc as never, CATALOG_EDGE: edge as never }, () =>
    fn(edge),
  )) as T;
}
const post = (
  caller: PlatformCaller | null,
  path: string,
  body?: unknown,
  h: Record<string, string> = {},
) => ucp(caller, 'POST', `/ucp/v1/catalog/${path}`, body, h);

// biome-ignore lint/suspicious/noExplicitAny: response bodies read as untyped JSON
type Body = Record<string, any>;
const ids = (b: Body) => (b.products as { id: string }[]).map((p) => p.id);

describe('UCP catalog search over REST', () => {
  it('searches the orders channel and serves only display fields, conforming to the schema', async () => {
    await onEdge(async (edge) => {
      const r = await post(shopper, 'search', { query: 'Cotton', pagination: { limit: 10 } });
      expect(r.status).toBe(200);
      expect(conformsTo(SEARCH, r.body)).toEqual([]);
      // The tee and the mug match; the scarf is priced in EUR only and the wholesale product is
      // in another channel.
      expect(ids(r.body)).toEqual(['tee', 'mug']);
      expect(r.body.pagination).toEqual({ has_next_page: false, total_count: 3 });
      const tee = r.body.products[0];
      expect(tee).toMatchObject({
        id: 'tee',
        title: 'Cotton tee',
        handle: 'tee',
        url: 'https://shop.example/p/tee',
        categories: [{ value: 'apparel', taxonomy: 'merchant' }],
        price_range: { min: usd(1800), max: usd(2200) },
        options: [
          {
            name: 'Size',
            values: [
              { id: 's', label: 'Small' },
              { id: 'l', label: 'Large' },
            ],
          },
        ],
      });
      expect(tee.variants.map((v: { id: string }) => v.id)).toEqual(['TEE-S', 'TEE-L']);
      // Prices are the catalog's list prices; the asset reference isn't something to fetch.
      expect(tee.media).toEqual([
        {
          type: 'image',
          url: 'https://cdn.example/tee.jpg',
          alt_text: 'A tee',
          width: 800,
          height: 600,
        },
      ]);
      // Nothing the document carries beyond what the mapping names leaves the engine.
      const text = JSON.stringify(r.body);
      for (const secret of ['margin is 60%', 'Acme Mills', 'costCents', 'internal_notes', 'asset:'])
        expect(text).not.toContain(secret);
      // Only the orders channel is ever read; a request is a plain GET of a canonical edge URL.
      expect(edge.asked.length).toBeGreaterThan(0);
      expect(edge.asked.every((p) => p.startsWith('/v1/web/en/'))).toBe(true);
      expect(edge.asked).toContain('/v1/web/en/search?q=cotton&limit=10');
      expect(text).not.toContain('secret-b2b');
    });
  });

  it('pages with an opaque cursor', async () => {
    await onEdge(async () => {
      const first = await post(shopper, 'search', { query: 'cotton', pagination: { limit: 1 } });
      expect(ids(first.body)).toEqual(['tee']);
      expect(first.body.pagination.has_next_page).toBe(true);
      const second = await post(shopper, 'search', {
        query: 'cotton',
        pagination: { limit: 1, cursor: first.body.pagination.cursor },
      });
      expect(ids(second.body)).toEqual(['mug']);
      expect(conformsTo(SEARCH, second.body)).toEqual([]);
    });
  });

  it('lists one category with a price range when there is no query', async () => {
    await onEdge(async (edge) => {
      const r = await post(shopper, 'search', {
        filters: { categories: ['apparel'], price: { min: 2000, max: 3000 } },
      });
      expect(conformsTo(SEARCH, r.body)).toEqual([]);
      expect(ids(r.body)).toEqual(['tee']);
      expect(edge.asked[0]).toBe(
        '/v1/web/en/categories/apparel/products?r.price=2000..3000&limit=10',
      );
    });
  });

  it('says what it needs when it gets neither a query nor exactly one category', async () => {
    await onEdge(async (edge) => {
      const r = await post(shopper, 'search', { filters: { categories: ['apparel', 'home'] } });
      expect(r.status).toBe(200);
      expect(r.body.products).toEqual([]);
      expect(r.body.messages).toEqual([
        expect.objectContaining({ type: 'info', code: 'query_required' }),
      ]);
      expect(conformsTo(SEARCH, r.body)).toEqual([]);
      expect(edge.asked).toEqual([]);
    });
  });

  it('shows the locale from context.language, then Accept-Language, and names options in it', async () => {
    await onEdge(async () => {
      const es = await post(shopper, 'search', { query: 'camiseta', context: { language: 'es' } });
      expect(es.body.products[0]).toMatchObject({
        title: 'Camiseta de algodon',
        options: [{ name: 'Talla', values: [{ label: 'Pequena' }, { label: 'Grande' }] }],
      });
      const accepted = await post(
        shopper,
        'search',
        { query: 'camiseta' },
        { 'accept-language': 'fr;q=0.9, es-MX;q=0.8, en;q=0.1' },
      );
      expect(ids(accepted.body)).toEqual(['tee']);
      // The context wins over the header; neither matching falls back to the channel's locale.
      const ctxWins = await post(
        shopper,
        'search',
        { query: 'cotton', context: { language: 'en' } },
        { 'accept-language': 'es' },
      );
      expect(ids(ctxWins.body)).toEqual(['tee', 'mug']);
      const fallback = await post(
        shopper,
        'search',
        { query: 'cotton' },
        { 'accept-language': 'de' },
      );
      expect(ids(fallback.body)).toEqual(['tee', 'mug']);
    });
  });

  it('prices in the channel currency only, says so for another, and ignores its price filter', async () => {
    await onEdge(async () => {
      const r = await post(shopper, 'search', {
        query: 'cotton',
        filters: { price: { max: 1 } },
        context: { currency: 'EUR' },
      });
      expect(ids(r.body)).toEqual(['tee', 'mug']);
      expect(r.body.messages.map((m: { code: string }) => m.code)).toEqual([
        'currency_unsupported',
        'price_filter_ignored',
      ]);
      expect(conformsTo(SEARCH, r.body)).toEqual([]);
    });
  });

  it('refuses a request that is not valid, a cursor that is not ours, and a method that is not POST', async () => {
    await onEdge(async () => {
      expect((await post(shopper, 'search', { pagination: { limit: 26 } })).status).toBe(400);
      expect((await post(shopper, 'search', { query: 'x'.repeat(1000) })).status).toBe(400);
      const bad = await post(shopper, 'search', { query: 'tee', pagination: { cursor: '!!' } });
      expect(bad).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
      const raw = await worker.fetch(
        new Request('https://engine/ucp/v1/catalog/search', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [PRINCIPAL_HEADER]: await signPlatform(platformKey, shopper, '/ucp/v1/catalog/search'),
          },
          body: '{nope',
        }),
        env,
      );
      expect(raw.status).toBe(400);
      const get = await worker.fetch(
        new Request('https://engine/ucp/v1/catalog/search', {
          headers: {
            [PRINCIPAL_HEADER]: await signPlatform(platformKey, shopper, '/ucp/v1/catalog/search'),
          },
        }),
        env,
      );
      expect(get.status).toBe(405);
      expect(get.headers.get('allow')).toBe('POST');
      expect((await post(shopper, 'nonsense', {})).status).toBe(404);
    });
  });

  it('takes only JSON, on the catalog routes and over MCP', async () => {
    await onEdge(async (edge) => {
      const sign = async (path: string) => ({
        [PRINCIPAL_HEADER]: await signPlatform(platformKey, shopper, path),
        'content-type': 'text/plain',
      });
      const rest = await worker.fetch(
        new Request('https://engine/ucp/v1/catalog/search', {
          method: 'POST',
          headers: await sign('/ucp/v1/catalog/search'),
          body: '{"query":"tee"}',
        }),
        env,
      );
      expect(rest.status).toBe(415);
      const mcp = await worker.fetch(
        new Request('https://engine/ucp/mcp', {
          method: 'POST',
          headers: await sign('/ucp/mcp'),
          body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
        }),
        env,
      );
      expect(mcp.status).toBe(415);
      expect(edge.asked).toEqual([]);
    });
  });

  it('asks for a signed platform, and a forged one is nobody', async () => {
    await onEdge(async (edge) => {
      expect((await post(null, 'search', { query: 'tee' })).status).toBe(401);
      expect(edge.asked).toEqual([]);
    });
  });
});

describe('UCP catalog lookup and get_product over REST', () => {
  it('looks up SKUs and keys together, each variant naming the ids that resolved to it', async () => {
    await onEdge(async () => {
      const r = await post(shopper, 'lookup', { ids: ['TEE-L', 'hat', 'ghost'] });
      expect(r.status).toBe(200);
      expect(conformsTo(LOOKUP, r.body)).toEqual([]);
      expect(ids(r.body)).toEqual(['tee', 'hat']);
      expect(r.body.products[0].variants).toEqual([
        expect.objectContaining({ id: 'TEE-L', inputs: [{ id: 'TEE-L', match: 'exact' }] }),
      ]);
      expect(r.body.products[1].variants[0].inputs).toEqual([{ id: 'hat', match: 'featured' }]);
      expect(r.body.messages).toEqual([
        expect.objectContaining({ type: 'info', code: 'not_found', path: '$.ids[2]' }),
      ]);
    });
  });

  it('never reaches the edge with an id that is not a code, and bounds the batch', async () => {
    await onEdge(async (edge) => {
      const r = await post(shopper, 'lookup', { ids: ['../b2b', 'a b', '%2e%2e'] });
      expect(r.body.products).toEqual([]);
      expect(edge.asked).toEqual([]);
      expect((await post(shopper, 'lookup', { ids: [] })).status).toBe(400);
      expect(
        (await post(shopper, 'lookup', { ids: Array.from({ length: 51 }, (_, i) => `id${i}`) }))
          .status,
      ).toBe(400);
    });
  });

  it('gets a product with its options narrowed to the selection', async () => {
    await onEdge(async () => {
      const r = await post(shopper, 'product', {
        id: 'tee',
        selected: [{ name: 'Size', id: 'l', label: 'Large' }],
      });
      expect(r.status).toBe(200);
      expect(conformsTo(PRODUCT, r.body)).toEqual([]);
      expect(r.body.product.selected).toEqual([{ name: 'Size', id: 'l', label: 'Large' }]);
      expect(r.body.product.options[0].values).toEqual([
        { id: 's', label: 'Small', available: true, exists: true },
        { id: 'l', label: 'Large', available: true, exists: true },
      ]);
      // By SKU, the selection is that variant's.
      const bySku = await post(shopper, 'product', { id: 'TEE-S' });
      expect(bySku.body.product.id).toBe('tee');
      expect(bySku.body.product.selected).toEqual([{ name: 'Size', id: 's', label: 'Small' }]);
    });
  });

  it('answers a product that is not there with an error response, not a failure', async () => {
    await onEdge(async () => {
      for (const id of ['ghost', 'scarf', '../b2b']) {
        const r = await post(shopper, 'product', { id });
        expect(r.status).toBe(200);
        expect(conformsTo(ERROR, r.body)).toEqual([]);
        expect(r.body.messages[0]).toMatchObject({ code: 'not_found', path: '$.id' });
      }
    });
  });
});

describe('UCP catalog capabilities', () => {
  const calls: [string, unknown][] = [
    ['search', { query: 'tee' }],
    ['lookup', { ids: ['tee'] }],
    ['product', { id: 'tee' }],
  ];

  it('refuses with 403 what the platform did not negotiate, and reads nothing', async () => {
    await onEdge(async (edge) => {
      for (const [path, body] of calls) {
        const r = await post(checkoutOnly, path, body);
        expect(r.status).toBe(403);
        expect(r.body).toEqual({
          code: 'forbidden',
          content: expect.stringContaining('dev.ucp.shopping.catalog.'),
        });
      }
      // Search alone doesn't grant lookup or get_product, and the reverse.
      expect((await post(searchOnly, 'search', { query: 'tee' })).status).toBe(200);
      expect((await post(searchOnly, 'lookup', { ids: ['tee'] })).status).toBe(403);
      expect((await post(searchOnly, 'product', { id: 'tee' })).status).toBe(403);
      expect(edge.asked.every((p) => p.includes('search?q=tee') || p.includes('/products/'))).toBe(
        true,
      );
      expect(edge.asked.some((p) => p.includes('/skus/'))).toBe(false);
    });
  });
});

describe('UCP catalog over MCP', () => {
  let n = 0;
  const rpc = async (
    caller: PlatformCaller,
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    const res = await worker.fetch(
      new Request('https://engine/ucp/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PRINCIPAL_HEADER]: await signPlatform(platformKey, caller, '/ucp/mcp'),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
      }),
      env,
    );
    // biome-ignore lint/suspicious/noExplicitAny: a response body read as untyped JSON
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const tool = (caller: PlatformCaller, name: string, catalog: unknown) =>
    rpc(caller, 'tools/call', {
      name,
      arguments: { meta: { 'ucp-agent': { profile: caller.profileUrl } }, catalog },
    });

  it('lists the three read tools, named in the service spec and marked read-only', async () => {
    const r = await rpc(shopper, 'tools/list');
    const tools = r.body.result.tools as {
      name: string;
      annotations: Record<string, boolean>;
      inputSchema: { required: string[] };
    }[];
    const spec = (mcpSpec as { methods: { name: string }[] }).methods.map((m) => m.name);
    for (const name of ['search_catalog', 'lookup_catalog', 'get_product']) {
      const t = tools.find((x) => x.name === name);
      expect(spec).toContain(name);
      expect(t?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t?.inputSchema.required).toEqual(['meta', 'catalog']);
    }
    // Every tool the engine lists is one the service spec defines.
    for (const t of tools) expect(spec).toContain(t.name);
  });

  it('searches, looks up and gets a product, the UCP body in structuredContent', async () => {
    await onEdge(async () => {
      const search = await tool(shopper, 'search_catalog', {
        query: 'camiseta',
        context: { language: 'es' },
      });
      expect(search.status).toBe(200);
      expect(conformsTo(SEARCH, search.body.result.structuredContent)).toEqual([]);
      expect(ids(search.body.result.structuredContent)).toEqual(['tee']);
      expect(JSON.parse(search.body.result.content[0].text)).toEqual(
        search.body.result.structuredContent,
      );
      const lookup = await tool(shopper, 'lookup_catalog', { ids: ['MUG-1'] });
      expect(conformsTo(LOOKUP, lookup.body.result.structuredContent)).toEqual([]);
      expect(ids(lookup.body.result.structuredContent)).toEqual(['mug']);
      const product = await tool(shopper, 'get_product', { id: 'hat' });
      expect(conformsTo(PRODUCT, product.body.result.structuredContent)).toEqual([]);
      expect(product.body.result.structuredContent.product.id).toBe('hat');
    });
  });

  it('refuses a tool whose capability was not negotiated, and bad arguments', async () => {
    await onEdge(async () => {
      const refused = await tool(checkoutOnly, 'search_catalog', { query: 'tee' });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatchObject({ code: -32000, data: { code: 'forbidden' } });
      expect((await tool(searchOnly, 'get_product', { id: 'tee' })).status).toBe(403);
      const bad = await tool(shopper, 'lookup_catalog', { ids: [] });
      expect(bad.status).toBe(400);
      expect(bad.body.error.data.code).toBe('invalid_request');
      // A call with no request at all is a bad one, not an empty search.
      const missing = await rpc(shopper, 'tools/call', {
        name: 'search_catalog',
        arguments: { meta: { 'ucp-agent': { profile: shopper.profileUrl } } },
      });
      expect(missing.status).toBe(400);
      // Another platform's profile in meta is refused as it is for checkout.
      const other = await rpc(shopper, 'tools/call', {
        name: 'search_catalog',
        arguments: { meta: { 'ucp-agent': { profile: 'https://evil.example/p' } }, catalog: {} },
      });
      expect(other.status).toBe(403);
    });
  });
});

describe('UCP catalog is read-only and keeps what it is told to itself', () => {
  it('stores nothing and claims no idempotency key', async () => {
    await onEdge(async () => {
      const before = (await db().select().from(checkoutSessions)).length;
      const k = key();
      await post(shopper, 'search', { query: 'tee' }, { 'idempotency-key': k });
      await post(shopper, 'lookup', { ids: ['tee'] }, { 'idempotency-key': k });
      expect((await db().select().from(checkoutSessions)).length).toBe(before);
      expect(await ucpStore(env).heldKey(shopper.id, k)).toBeUndefined();
    });
  });

  it('logs nothing of a request’s context, signals or query, on success or when the edge is down', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, level).mockImplementation((...a) => {
        logged.push(a.map(String).join(' '));
      });
    await onEdge(async (edge) => {
      const body = {
        query: 'tee',
        context: {
          language: 'es',
          currency: 'USD',
          intent: 'a surprise gift for my wife',
          address_country: 'ZZ',
        },
        signals: { 'dev.ucp.buyer_ip': '203.0.113.99', 'dev.ucp.user_agent': 'curl-secret' },
      };
      expect((await post(shopper, 'search', body)).status).toBe(200);
      edge.failWith503();
      const down = await post(shopper, 'search', body);
      expect(down).toMatchObject({ status: 503, body: { code: 'catalog_unavailable' } });
      expect(JSON.stringify(down.body)).not.toMatch(/gift|203\.0|curl/);
    });
    expect(logged.join('\n')).not.toMatch(/gift|wife|203\.0|curl-secret|ZZ/);
    // The failure was logged, without what was asked.
    expect(logged.some((l) => l.includes('catalog edge'))).toBe(true);
  });
});

describe('checkout needs the checkout capability', () => {
  const entryFor = (c: string) => entry(c.replace('dev.ucp.', '').replaceAll('.', '/'));
  const only = (...caps: string[]) => ({
    ucp: {
      version: UCP_VERSION,
      services: {},
      payment_handlers: {},
      capabilities: Object.fromEntries(caps.map((c) => [c, [entryFor(c)]])),
    },
  });
  const rpcCall = async (caller: PlatformCaller, name: string, args: Record<string, unknown>) => {
    const res = await worker.fetch(
      new Request('https://engine/ucp/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PRINCIPAL_HEADER]: await signPlatform(platformKey, caller, '/ucp/mcp'),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name,
            arguments: { meta: { 'ucp-agent': { profile: caller.profileUrl } }, ...args },
          },
        }),
      }),
      env,
    );
    // biome-ignore lint/suspicious/noExplicitAny: a response body read as untyped JSON
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it('refuses every checkout route and tool to a platform that negotiated only the catalog or only orders', async () => {
    const catalogOnly = await platform(
      'cat_only',
      only(CATALOG_SEARCH_CAPABILITY, CATALOG_LOOKUP_CAPABILITY),
    );
    const orderOnly = await platform('order_only', only('dev.ucp.shopping.order'));
    const before = (await db().select().from(checkoutSessions)).length;
    const idem = { 'idempotency-key': key() };
    for (const caller of [catalogOnly, orderOnly]) {
      const rest: [string, string, unknown?][] = [
        [
          'POST',
          '/ucp/v1/checkout-sessions',
          { line_items: [{ item: { id: 'MON-27' }, quantity: 1 }] },
        ],
        ['GET', '/ucp/v1/checkout-sessions/chk_1'],
        ['PUT', '/ucp/v1/checkout-sessions/chk_1', { line_items: [] }],
        ['POST', '/ucp/v1/checkout-sessions/chk_1/complete', {}],
        ['POST', '/ucp/v1/checkout-sessions/chk_1/cancel', {}],
      ];
      for (const [method, path, body] of rest) {
        const r = await ucp(caller, method, path, body, idem);
        expect([method, path, r.status, r.body.code]).toEqual([method, path, 403, 'forbidden']);
        expect(r.body.content).toContain('dev.ucp.shopping.checkout');
      }
      const tools: [string, Record<string, unknown>][] = [
        ['create_checkout', { checkout: { line_items: [] } }],
        ['get_checkout', { id: 'chk_1' }],
        ['update_checkout', { id: 'chk_1', checkout: {} }],
        ['complete_checkout', { id: 'chk_1', checkout: {} }],
        ['cancel_checkout', { id: 'chk_1' }],
      ];
      for (const [name, args] of tools) {
        const r = await rpcCall(caller, name, args);
        expect([name, r.status, r.body.error?.data?.code]).toEqual([name, 403, 'forbidden']);
      }
    }
    // Nothing was created, and no idempotency key was claimed by a refused call.
    expect((await db().select().from(checkoutSessions)).length).toBe(before);
    expect(await ucpStore(env).heldKey(catalogOnly.id, idem['idempotency-key'])).toBeUndefined();
    // Orders stay open to the order-only platform (its own capability), and a platform with
    // checkout still checks out.
    expect((await ucp(orderOnly, 'GET', '/ucp/v1/orders/ord_x')).status).toBe(200);
    expect((await ucp(shopper, 'GET', '/ucp/v1/checkout-sessions/chk_missing')).status).not.toBe(
      403,
    );
  });
});
