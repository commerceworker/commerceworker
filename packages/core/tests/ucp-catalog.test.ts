import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  detailOptions,
  encodeCursor,
  lookupProducts,
  paginate,
  toUcpDetailProduct,
  toUcpProduct,
  type UcpCatalogContext,
  ucpCatalogEnvelope,
  ucpGetProductInput,
  ucpLookupInput,
  ucpSearchInput,
} from '../src';
import type { ProductDoc, PublishedVariant } from '../src/product/render';
import { QUERY_MAX } from '../src/product/search';

const ROOT = join(__dirname, 'fixtures/ucp/schemas');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.json') ? [p] : [];
  });
const schemas = files(ROOT).map((p) => JSON.parse(readFileSync(p, 'utf8')) as { $id: string });

function conformsTo(ref: string, value: unknown) {
  const v = new Validator({ $ref: `https://ucp.dev/schemas/${ref}` }, '2020-12', false);
  for (const s of schemas) v.addSchema(s as never, s.$id);
  const r = v.validate(value);
  return r.valid ? [] : r.errors.map((e) => `${e.instanceLocation}: ${e.error}`);
}

const usd = (amount: number) => ({ amount, currency: 'USD' });
const ctx: UcpCatalogContext = {
  axisNames: { color: 'Color', size: 'Size' },
  productUrl: 'https://shop.example/p/{slug}',
  currency: 'USD',
};

const variant = (sku: string, over: Partial<PublishedVariant> = {}): PublishedVariant => ({
  sku,
  status: 'active',
  options: {},
  attributes: {},
  price: usd(2000),
  ...over,
});
const opt = (axis: string, code: string, label: string) => ({ [axis]: { code, label } });

const doc = (over: Partial<ProductDoc> = {}): ProductDoc => ({
  key: 'tee',
  type: 'apparel@1',
  version: 3,
  updatedAt: 1,
  title: 'Cotton tee',
  slug: 'cotton-tee',
  description: 'Soft and plain.',
  categories: ['apparel'],
  media: [{ src: 'https://cdn.example/tee.jpg', alt: 'A tee', width: 800, height: 600 }],
  attributes: {},
  variants: [variant('TEE-1')],
  ...over,
});

const twoAxes = doc({
  variants: [
    variant('TEE-BL-L', {
      gtin: '0123456789012',
      options: { ...opt('color', 'blue', 'Blue'), ...opt('size', 'l', 'Large') },
    }),
    variant('TEE-BL-S', {
      price: usd(1800),
      options: { ...opt('color', 'blue', 'Blue'), ...opt('size', 's', 'Small') },
    }),
    variant('TEE-RD-L', {
      options: { ...opt('color', 'red', 'Red'), ...opt('size', 'l', 'Large') },
    }),
  ],
});

const search = (products: unknown[], pagination?: unknown) => ({
  ucp: ucpCatalogEnvelope(),
  products,
  ...(pagination ? { pagination } : {}),
});

describe('toUcpProduct', () => {
  it('maps a product with no axes and conforms to the search response', () => {
    const p = toUcpProduct(doc(), ctx);
    expect(p).toMatchObject({
      id: 'tee',
      title: 'Cotton tee',
      description: { plain: 'Soft and plain.' },
      handle: 'cotton-tee',
      url: 'https://shop.example/p/cotton-tee',
      categories: [{ value: 'apparel', taxonomy: 'merchant' }],
      price_range: { min: usd(2000), max: usd(2000) },
      media: [
        {
          type: 'image',
          url: 'https://cdn.example/tee.jpg',
          alt_text: 'A tee',
          width: 800,
          height: 600,
        },
      ],
    });
    expect(p?.options).toBeUndefined();
    expect(p?.variants[0]).toMatchObject({ id: 'TEE-1', sku: 'TEE-1', title: 'Cotton tee' });
    expect(conformsTo('shopping/catalog_search.json#/$defs/search_response', search([p]))).toEqual(
      [],
    );
  });

  it('maps two axes into options, variant titles and barcodes', () => {
    const p = toUcpProduct(twoAxes, ctx);
    expect(p?.options).toEqual([
      {
        name: 'Color',
        values: [
          { id: 'blue', label: 'Blue' },
          { id: 'red', label: 'Red' },
        ],
      },
      {
        name: 'Size',
        values: [
          { id: 'l', label: 'Large' },
          { id: 's', label: 'Small' },
        ],
      },
    ]);
    expect(p?.variants[0]).toMatchObject({
      id: 'TEE-BL-L',
      title: 'Blue / Large',
      barcodes: [{ type: 'GTIN', value: '0123456789012' }],
      options: [
        { name: 'Color', id: 'blue', label: 'Blue' },
        { name: 'Size', id: 'l', label: 'Large' },
      ],
    });
    // The document has no range: it comes from the variants.
    expect(p?.price_range).toEqual({ min: usd(1800), max: usd(2000) });
    expect(conformsTo('shopping/catalog_search.json#/$defs/search_response', search([p]))).toEqual(
      [],
    );
  });

  it('uses the document range and list price when it has them', () => {
    const p = toUcpProduct(
      doc({ priceRange: { min: usd(1500), max: usd(2500) }, compareAt: usd(3000) }),
      ctx,
    );
    expect(p?.price_range).toEqual({ min: usd(1500), max: usd(2500) });
    expect(p?.list_price_range).toEqual({ min: usd(3000), max: usd(3000) });
  });

  it('falls back to the title with no description', () => {
    const p = toUcpProduct(doc({ description: undefined }), ctx);
    expect(p?.description).toEqual({ plain: 'Cotton tee' });
    expect(p?.variants[0]?.description).toEqual({ plain: 'Cotton tee' });
    expect(conformsTo('shopping/catalog_search.json#/$defs/search_response', search([p]))).toEqual(
      [],
    );
  });

  it('drops asset: and non-https media, on the product and its variants', () => {
    const p = toUcpProduct(
      doc({
        media: [
          { src: 'asset:abc' },
          { src: 'http://cdn.example/a.jpg' },
          { src: 'not a url' },
          { src: 'https://cdn.example/ok.jpg' },
        ],
        variants: [variant('TEE-1', { media: [{ src: 'asset:def' }] })],
      }),
      ctx,
    );
    expect(p?.media).toEqual([{ type: 'image', url: 'https://cdn.example/ok.jpg' }]);
    expect(p?.variants[0]?.media).toBeUndefined();
    const none = toUcpProduct(doc({ media: [{ src: 'asset:abc' }] }), ctx);
    expect(none?.media).toBeUndefined();
  });

  it('drops unpriced and wrong-currency variants, and a product left with none', () => {
    const mixed = doc({
      variants: [
        variant('OK'),
        variant('NOPRICE', { price: undefined }),
        variant('EUR', { price: { amount: 1900, currency: 'EUR' } }),
      ],
    });
    expect(toUcpProduct(mixed, ctx)?.variants.map((v) => v.id)).toEqual(['OK']);
    // A document range in another currency is not used.
    expect(
      toUcpProduct(
        doc({
          priceRange: { min: { amount: 1, currency: 'EUR' }, max: { amount: 2, currency: 'EUR' } },
        }),
        ctx,
      )?.price_range,
    ).toEqual({ min: usd(2000), max: usd(2000) });
    expect(toUcpProduct(doc({ variants: [variant('A', { price: undefined })] }), ctx)).toBeNull();
    expect(toUcpProduct(doc(), { ...ctx, currency: 'EUR' })).toBeNull();
  });

  it('leaves out the url without a slug for a {slug} template, and fills {key}', () => {
    expect(toUcpProduct(doc({ slug: undefined }), ctx)).not.toHaveProperty('url');
    expect(
      toUcpProduct(doc({ slug: undefined }), { ...ctx, productUrl: 'https://shop.example/p/{key}' })
        ?.url,
    ).toBe('https://shop.example/p/tee');
    expect(toUcpProduct(doc(), { ...ctx, productUrl: undefined })).not.toHaveProperty('url');
    expect(
      toUcpProduct(doc(), { ...ctx, productUrl: 'http://shop.example/{slug}' }),
    ).not.toHaveProperty('url');
  });

  it('emits only the allowlist: no attributes, extra, brand, cost, stock or supplier', () => {
    const rich = doc({
      brand: 'Acme',
      attributes: { cost: 4, supplier: 'Globex', stock: 99 },
      extra: { margin: 0.6, internal: 'x' },
      variants: [variant('S1', { attributes: { cost: 3, stock: 5, supplier: 'Globex' } })],
    });
    const json = JSON.stringify(toUcpProduct(rich, ctx));
    for (const leak of [
      'attributes',
      'extra',
      'margin',
      'Globex',
      'cost',
      'stock',
      'supplier',
      'Acme',
    ])
      expect(json).not.toContain(leak);
  });
});

describe('lookup', () => {
  const docs = [twoAxes, doc()];

  it('resolves a SKU exactly and a product key to its cheapest variant', () => {
    const products = lookupProducts(docs, ['TEE-RD-L', 'tee', 'missing'], ctx);
    // `tee` is the single-variant product; the two-axis one is keyed `tee` too, so use distinct keys.
    expect(products.length).toBeGreaterThan(0);
    const lone = lookupProducts(
      [twoAxes, doc({ key: 'plain' })],
      ['TEE-RD-L', 'tee', 'plain', 'nope'],
      ctx,
    );
    const byId = Object.fromEntries(lone.map((p) => [p.id, p.variants]));
    expect(byId.tee?.map((v) => [v.id, v.inputs])).toEqual([
      ['TEE-BL-S', [{ id: 'tee', match: 'featured' }]],
      ['TEE-RD-L', [{ id: 'TEE-RD-L', match: 'exact' }]],
    ]);
    expect(byId.plain?.[0]?.inputs).toEqual([{ id: 'plain', match: 'featured' }]);
    expect(
      conformsTo('shopping/catalog_lookup.json#/$defs/lookup_response', {
        ucp: ucpCatalogEnvelope(),
        products: lone,
      }),
    ).toEqual([]);
  });

  it('merges inputs that resolve to the same variant and omits unknown ids', () => {
    const [p] = lookupProducts([doc()], ['TEE-1', 'tee'], ctx);
    expect(p?.variants[0]?.inputs).toEqual([
      { id: 'TEE-1', match: 'exact' },
      { id: 'tee', match: 'featured' },
    ]);
    expect(lookupProducts([doc()], ['nope'], ctx)).toEqual([]);
    expect(
      lookupProducts([doc({ variants: [variant('X', { price: undefined })] })], ['X', 'tee'], ctx),
    ).toEqual([]);
  });
});

describe('get_product narrowing', () => {
  it('flags values against the other selections', () => {
    const d = detailOptions(twoAxes, [{ name: 'Color', id: 'red', label: 'Red' }], [], ctx);
    expect(d.selected).toEqual([{ name: 'Color', id: 'red', label: 'Red' }]);
    const size = d.options.find((o) => o.name === 'Size');
    // Only a Large red tee exists.
    expect(size?.values).toEqual([
      { id: 'l', label: 'Large', exists: true, available: true },
      { id: 's', label: 'Small', exists: false, available: false },
    ]);
    // A selection never narrows its own option.
    expect(d.options.find((o) => o.name === 'Color')?.values.every((v) => v.exists)).toBe(true);
  });

  it('selects by label, orders by preference and ignores unknown selections', () => {
    const d = detailOptions(
      twoAxes,
      [
        { name: 'size', label: 'Small' },
        { name: 'Weight', label: 'Heavy' },
        { name: 'Color', label: 'Green' },
      ],
      ['Size'],
      ctx,
    );
    expect(d.options.map((o) => o.name)).toEqual(['Size', 'Color']);
    expect(d.selected).toEqual([{ name: 'Size', id: 's', label: 'Small' }]);
    expect(d.options[1]?.values).toEqual([
      { id: 'blue', label: 'Blue', exists: true, available: true },
      { id: 'red', label: 'Red', exists: false, available: false },
    ]);
  });

  it('conforms to get_product_response, with and without options', () => {
    for (const [d, sel] of [
      [twoAxes, [{ name: 'Color', id: 'blue', label: 'Blue' }]],
      [doc(), []],
    ] as const) {
      const product = toUcpDetailProduct(d, [...sel], [], ctx);
      expect(
        conformsTo('shopping/catalog_lookup.json#/$defs/get_product_response', {
          ucp: ucpCatalogEnvelope(),
          product,
        }),
      ).toEqual([]);
    }
    expect(toUcpDetailProduct(doc(), [], [], { ...ctx, currency: 'EUR' })).toBeNull();
  });
});

describe('requests and pagination', () => {
  it('bounds a search: query, limit and the default', () => {
    expect(ucpSearchInput.parse({}).pagination.limit).toBe(10);
    expect(ucpSearchInput.safeParse({ query: 'x'.repeat(QUERY_MAX + 1) }).success).toBe(false);
    expect(ucpSearchInput.safeParse({ pagination: { limit: 26 } }).success).toBe(false);
    expect(ucpSearchInput.safeParse({ pagination: { limit: 0 } }).success).toBe(false);
    expect(
      ucpSearchInput.safeParse({
        query: 'tee',
        filters: { categories: ['apparel'], price: { max: 5000 }, other: 1 },
        context: { currency: 'USD', intent: 'gift' },
        pagination: { limit: 25 },
      }).success,
    ).toBe(true);
  });

  it('bounds a lookup and get_product', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`);
    expect(ucpLookupInput.safeParse({ ids: ids(50) }).success).toBe(true);
    expect(ucpLookupInput.safeParse({ ids: ids(51) }).success).toBe(false);
    expect(ucpLookupInput.safeParse({ ids: [] }).success).toBe(false);
    const sel = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `n${i}`, label: 'l' }));
    expect(ucpGetProductInput.safeParse({ id: 'tee', selected: sel(5) }).success).toBe(true);
    expect(ucpGetProductInput.safeParse({ id: 'tee', selected: sel(6) }).success).toBe(false);
  });

  it('pages with an opaque cursor and refuses a forged one', () => {
    const items = [1, 2, 3, 4, 5];
    const first = paginate(items, { limit: 2 });
    expect(first?.items).toEqual([1, 2]);
    expect(first?.pagination.has_next_page).toBe(true);
    const cursor = first?.pagination.cursor;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = paginate(items, { cursor, limit: 2 });
    expect(second?.items).toEqual([3, 4]);
    const last = paginate(items, { cursor: second?.pagination.cursor, limit: 2 });
    expect(last?.items).toEqual([5]);
    expect(last?.pagination).toEqual({ has_next_page: false });
    expect(paginate(items, { cursor: 'garbage!', limit: 2 })).toBeNull();
    expect(paginate(items, { cursor: btoa('o:-1'), limit: 2 })).toBeNull();
    expect(decodeCursor(encodeCursor(40))).toBe(40);
    expect(decodeCursor(undefined)).toBe(0);
  });

  it('a page with a next cursor conforms; has_next_page without one would not', () => {
    const page = paginate(
      [toUcpProduct(doc(), ctx), toUcpProduct(doc({ key: 'b' }), ctx)],
      { limit: 1 },
      2,
    );
    expect(page?.pagination).toMatchObject({ has_next_page: true, total_count: 2 });
    expect(
      conformsTo(
        'shopping/catalog_search.json#/$defs/search_response',
        search(page?.items ?? [], page?.pagination),
      ),
    ).toEqual([]);
    expect(
      conformsTo(
        'shopping/catalog_search.json#/$defs/search_response',
        search([], { has_next_page: true }),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('the vendored shopping service specs', () => {
  const dir = join(ROOT, '../services/shopping');
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const rest = read('rest.openapi.json');
  const mcp = read('mcp.openrpc.json');

  /** A `../../schemas/...#/$defs/x` ref must name a vendored file and a definition in it. */
  const resolves = (ref: string) => {
    const [file = '', pointer] = ref.split('#');
    const target = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    return (
      (pointer ?? '')
        .split('/')
        .filter(Boolean)
        .reduce((o, k) => o?.[k], target) !== undefined
    );
  };
  const refsIn = (v: unknown): string[] =>
    typeof v === 'object' && v
      ? Object.entries(v).flatMap(([k, x]) =>
          k === '$ref' && typeof x === 'string' ? [x] : refsIn(x),
        )
      : [];
  const external = (v: unknown) => refsIn(v).filter((r) => r.startsWith('../'));

  it('declare the catalog operations the services must implement', () => {
    const op = (path: string) => rest.paths[path]?.post;
    expect(op('/catalog/search')?.operationId).toBe('search_catalog');
    expect(op('/catalog/lookup')?.operationId).toBe('lookup_catalog');
    expect(op('/catalog/product')?.operationId).toBe('get_product');
    const methods = mcp.methods.map((m: { name: string }) => m.name);
    expect(methods).toEqual(
      expect.arrayContaining(['search_catalog', 'lookup_catalog', 'get_product']),
    );
  });

  it('point REST and MCP at the catalog schemas the mapping conforms to', () => {
    const s = rest.components.schemas;
    expect(s.catalog_search_response.$ref).toBe(
      '../../schemas/shopping/catalog_search.json#/$defs/search_response',
    );
    expect(s.catalog_lookup_response.$ref).toBe(
      '../../schemas/shopping/catalog_lookup.json#/$defs/lookup_response',
    );
    expect(external(s.catalog_get_product_response)).toContain(
      '../../schemas/shopping/catalog_lookup.json#/$defs/get_product_response',
    );
    const method = (name: string) => mcp.methods.find((m: { name: string }) => m.name === name);
    expect(method('search_catalog').result.schema.$ref).toBe(
      '../../schemas/shopping/catalog_search.json#/$defs/search_response',
    );
    expect(method('lookup_catalog').result.schema.$ref).toBe(
      '../../schemas/shopping/catalog_lookup.json#/$defs/lookup_response',
    );
    expect(external(mcp.components.schemas.catalog_get_product_result)).toContain(
      '../../schemas/shopping/catalog_lookup.json#/$defs/get_product_response',
    );
  });

  it('resolve every external ref to a vendored schema', () => {
    const refs = [...external(rest), ...external(mcp)];
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !resolves(r))).toEqual([]);
  });
});
