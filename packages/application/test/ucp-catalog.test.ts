import type { ProductDoc, PublishedVariant } from '@commerceworker/core/product';
import {
  CATALOG_CHANNEL,
  type CatalogReaderFixture,
  InMemoryCatalogReader,
  InMemoryInventoryStore,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  catalogLocale,
  getCatalogProduct,
  lookupCatalog,
  SEARCH_WINDOW,
  searchCatalog,
} from '../src/commerce';

const usd = (amount: number) => ({ amount, currency: 'USD' });
const variant = (sku: string, amount: number, over: Partial<PublishedVariant> = {}) =>
  ({
    sku,
    status: 'active',
    options: {},
    attributes: {},
    price: usd(amount),
    ...over,
  }) as PublishedVariant;
const doc = (key: string, over: Partial<ProductDoc> = {}): ProductDoc => ({
  key,
  type: 'apparel@1',
  version: 1,
  updatedAt: 1,
  title: key,
  slug: key,
  description: `About ${key}`,
  categories: ['apparel'],
  media: [],
  attributes: {},
  variants: [variant(`${key.toUpperCase()}-1`, 2000)],
  ...over,
});

const tee = doc('tee', {
  title: 'Cotton tee',
  variants: [
    variant('TEE-S', 1800, { options: { size: { code: 's', label: 'Small' } } }),
    variant('TEE-L', 2200, { options: { size: { code: 'l', label: 'Large' } } }),
  ],
});
const hat = doc('hat', {
  title: 'Wool hat',
  categories: ['accessories'],
  variants: [variant('HAT-1', 4000)],
});
const mug = doc('mug', {
  title: 'Cotton mug',
  categories: ['home'],
  variants: [variant('MUG-1', 900)],
});
const euro = doc('scarf', {
  title: 'Cotton scarf',
  variants: [variant('SCARF-1', 3000, { price: { amount: 3000, currency: 'EUR' } })],
});

const setup = (over: CatalogReaderFixture = {}) => {
  const catalog = new InMemoryCatalogReader({
    docs: { en: [tee, hat, mug, euro], es: [{ ...tee, title: 'Camiseta de algodon' }] },
    axes: { en: { apparel: { size: 'Size' } }, es: { apparel: { size: 'Talla' } } },
    ...over,
  });
  // Stock: the small tee is in stock, the large one is out, the hat is all held, and the mug has no
  // stock row at all (nothing known). The spy counts what the use-case asked the store.
  const inventory = new InMemoryInventoryStore({
    products: [
      { sku: 'TEE-S', stock: 5 },
      { sku: 'TEE-L', stock: 0 },
      { sku: 'HAT-1', stock: 2, reserved: 2 },
    ],
  });
  const asked: string[][] = [];
  const spy = {
    availability: (skus: readonly string[]) => {
      asked.push([...skus]);
      return inventory.availability(skus);
    },
  };
  return { catalog, asked, ports: { catalog, inventory: spy } };
};
const settings = { productUrl: 'https://shop.example/p/{slug}' };
const page = (limit = 10, cursor?: string) => ({ limit, ...(cursor ? { cursor } : {}) });
const methods = (c: InMemoryCatalogReader) => c.calls.map((x) => x.method);
type Body = {
  products: { id: string; url?: string; options?: { name: string }[]; price_range: unknown }[];
  pagination?: { has_next_page: boolean; cursor?: string; total_count?: number };
  messages?: { type: string; code: string; path?: string }[];
  ucp: { status: string };
};
const body = (r: { body: unknown }) => r.body as Body;

describe('searchCatalog', () => {
  it('searches a query in the orders channel, maps each hit and links it to the product page', async () => {
    const { catalog, ports } = setup();
    const r = await searchCatalog(ports, settings, { query: ' COTTON ', pagination: page() });
    expect(r.status).toBe(200);
    expect(body(r).products.map((p) => p.id)).toEqual(['tee', 'mug']);
    expect(body(r).products[0]).toMatchObject({ url: 'https://shop.example/p/tee' });
    expect(body(r).pagination).toEqual({ has_next_page: false, total_count: 3 });
    // The channel's code and the normalized query reach the edge; the EUR-only scarf maps to nothing.
    expect(catalog.calls.find((c) => c.method === 'search')?.args).toEqual([
      'web',
      'en',
      'cotton',
      { limit: 10, offset: 0 },
    ]);
  });

  it('pages with an opaque cursor over the edge’s offsets', async () => {
    const { ports } = setup();
    const first = body(
      await searchCatalog(ports, settings, { query: 'cotton', pagination: page(1) }),
    );
    expect(first.products.map((p) => p.id)).toEqual(['tee']);
    expect(first.pagination?.has_next_page).toBe(true);
    const second = body(
      await searchCatalog(ports, settings, {
        query: 'cotton',
        pagination: page(1, first.pagination?.cursor),
      }),
    );
    expect(second.products.map((p) => p.id)).toEqual(['mug']);
  });

  it('refuses a cursor that is not ours, on either path', async () => {
    const { catalog, ports } = setup();
    for (const input of [
      { query: 'cotton', pagination: page(10, 'nope!') },
      { filters: { categories: ['apparel'] }, pagination: page(10, 'nope!') },
    ]) {
      const r = await searchCatalog(ports, settings, input);
      expect(r).toEqual({
        status: 400,
        body: { code: 'invalid_request', content: 'The cursor is not valid.' },
      });
    }
    expect(methods(catalog)).not.toContain('search');
    expect(methods(catalog)).not.toContain('listing');
  });

  it('needs a query or exactly one category, and otherwise says so and reads nothing', async () => {
    const { catalog, ports } = setup();
    for (const filters of [undefined, { categories: [] }, { categories: ['apparel', 'home'] }]) {
      const r = await searchCatalog(ports, settings, { filters, pagination: page() });
      expect(body(r).products).toEqual([]);
      expect(body(r).messages).toMatchObject([{ type: 'info', code: 'query_required' }]);
      expect(body(r).ucp.status).toBe('success');
    }
    expect(methods(catalog)).toEqual(['channel', 'channel', 'channel']);
  });

  it('lists one category without a query, with the price range, and never searches', async () => {
    const { catalog, ports } = setup();
    const r = await searchCatalog(ports, settings, {
      filters: { categories: ['apparel'], price: { min: 2000, max: 2500 } },
      pagination: page(),
    });
    // The tee has a variant at 2200; its mapped variants are those in range.
    expect(body(r).products.map((p) => p.id)).toEqual(['tee']);
    expect(body(r).products[0]?.price_range).toEqual({ min: usd(2200), max: usd(2200) });
    const listing = catalog.calls.find((c) => c.method === 'listing');
    expect(listing?.args).toEqual([
      'web',
      'en',
      'apparel',
      { limit: 10, price: { min: 2000, max: 2500 } },
    ]);
    expect(methods(catalog)).not.toContain('search');
  });

  it('pages a listing with the edge’s own cursor', async () => {
    const { ports } = setup({ docs: { en: [doc('a'), doc('b'), doc('c')] } });
    const first = body(
      await searchCatalog(ports, settings, {
        filters: { categories: ['apparel'] },
        pagination: page(2),
      }),
    );
    expect(first.products).toHaveLength(2);
    expect(first.pagination).toMatchObject({ has_next_page: true, total_count: 3 });
    const second = body(
      await searchCatalog(ports, settings, {
        filters: { categories: ['apparel'] },
        pagination: page(2, first.pagination?.cursor),
      }),
    );
    expect(second.products.map((p) => p.id)).toEqual(['c']);
    expect(second.pagination).toEqual({ has_next_page: false, total_count: 3 });
  });

  it('answers an unknown category with an empty page', async () => {
    const { ports } = setup();
    const r = await searchCatalog(ports, settings, {
      filters: { categories: ['nowhere'] },
      pagination: page(),
    });
    expect(body(r)).toMatchObject({ products: [], pagination: { has_next_page: false } });
  });

  it('post-filters a query by category and price over the best matches', async () => {
    const { catalog, ports } = setup();
    const r = await searchCatalog(ports, settings, {
      query: 'cotton',
      filters: { categories: ['home'] },
      pagination: page(),
    });
    expect(body(r).products.map((p) => p.id)).toEqual(['mug']);
    const priced = await searchCatalog(ports, settings, {
      query: 'cotton',
      filters: { price: { max: 1000 } },
      pagination: page(),
    });
    expect(body(priced).products.map((p) => p.id)).toEqual(['mug']);
    expect(catalog.calls.filter((c) => c.method === 'search').map((c) => c.args[3])).toEqual([
      { limit: SEARCH_WINDOW, offset: 0 },
      { limit: SEARCH_WINDOW, offset: 0 },
    ]);
  });

  it('pages a filtered query over what the filter kept', async () => {
    const { ports } = setup({ docs: { en: [doc('a'), doc('b'), doc('c')] } });
    const input = { query: 'about', filters: { categories: ['apparel'] } };
    const first = body(await searchCatalog(ports, settings, { ...input, pagination: page(2) }));
    expect(first.products.map((p) => p.id)).toEqual(['a', 'b']);
    const second = body(
      await searchCatalog(ports, settings, {
        ...input,
        pagination: page(2, first.pagination?.cursor),
      }),
    );
    expect(second.products.map((p) => p.id)).toEqual(['c']);
    expect(second.pagination).toEqual({ has_next_page: false, total_count: 3 });
  });

  it('shows only the channel’s currency, tells the platform when it asked for another, and ignores its price filter', async () => {
    const { ports } = setup();
    const r = await searchCatalog(ports, settings, {
      query: 'cotton',
      filters: { price: { max: 1 } },
      context: { currency: 'EUR' },
      pagination: page(),
    });
    // The EUR scarf is no more shown than before; the price filter (max 1) didn't empty the page.
    expect(body(r).products.map((p) => p.id)).toEqual(['tee', 'mug']);
    expect(body(r).messages).toEqual([
      { type: 'info', code: 'currency_unsupported', content: expect.stringContaining('USD') },
      {
        type: 'warning',
        code: 'price_filter_ignored',
        content: expect.stringContaining('EUR'),
        path: '$.filters.price',
      },
    ]);
  });

  it('reads the locale from context.language, then Accept-Language, then the channel default', async () => {
    const { catalog, ports } = setup();
    const title = async (context: object | undefined, accept: string[]) => {
      const r = await searchCatalog(
        ports,
        settings,
        { query: 'tee camiseta cotton', context, pagination: page() },
        accept,
      );
      return catalog.calls.filter((c) => c.method === 'search').at(-1)?.args[1] ?? r;
    };
    expect(await title({ language: 'es-MX' }, ['en'])).toBe('es');
    expect(await title(undefined, ['fr', 'es'])).toBe('es');
    expect(await title(undefined, [])).toBe('en');
  });

  it('names the option axes in the response locale', async () => {
    const { ports } = setup({
      docs: { en: [tee], es: [{ ...tee, title: 'Camiseta' }] },
    });
    const r = await searchCatalog(ports, settings, {
      query: 'camiseta',
      context: { language: 'es' },
      pagination: page(),
    });
    expect(body(r).products[0]?.options?.[0]?.name).toBe('Talla');
  });

  it('says the catalog is unavailable when the orders channel does not exist', async () => {
    const { ports } = setup({ channel: null });
    const r = await searchCatalog(ports, settings, { query: 'cotton', pagination: page() });
    expect(r.body).toMatchObject({
      ucp: { status: 'error' },
      messages: [{ code: 'catalog_unavailable', severity: 'unrecoverable' }],
    });
  });

  it('tells the platform when keyword search could not reach every shard', async () => {
    const { ports } = setup({ partial: true });
    const r = await searchCatalog(ports, settings, { query: 'cotton', pagination: page() });
    expect(body(r).messages).toMatchObject([{ code: 'search_partial' }]);
  });

  it('leaves out the product link when none is configured', async () => {
    const { ports } = setup();
    const r = await searchCatalog(
      ports,
      { productUrl: null },
      { query: 'cotton', pagination: page() },
    );
    expect(body(r).products.every((p) => p.url === undefined)).toBe(true);
  });
});

type Shown = {
  id: string;
  variants: { id: string; availability?: unknown; barcodes?: unknown; inputs?: unknown }[];
};

describe('availability', () => {
  it('shows each variant in or out of stock, and nothing for a SKU the inventory does not know', async () => {
    const { ports } = setup();
    const r = await searchCatalog(ports, settings, { query: 'cotton', pagination: page() });
    const tee = (body(r).products as unknown as Shown[]).find((p) => p.id === 'tee');
    expect(tee?.variants.map((v) => [v.id, v.availability])).toEqual([
      ['TEE-S', { available: true, status: 'in_stock' }],
      ['TEE-L', { available: false, status: 'out_of_stock' }],
    ]);
    const mug = (body(r).products as unknown as Shown[]).find((p) => p.id === 'mug');
    expect(mug?.variants[0]).not.toHaveProperty('availability');
  });

  it('never carries a count, whatever the stock is', async () => {
    const { ports } = setup();
    const r = await lookupCatalog(ports, settings, { ids: ['tee', 'hat'] });
    expect(JSON.stringify(body(r))).not.toMatch(/quantity|stock":\d|reserved|"count"/);
    expect(
      Object.keys(
        (body(r).products[0] as unknown as Shown).variants[0]?.availability as object,
      ).sort(),
    ).toEqual(['available', 'status']);
  });

  it('reads stock once for a response, over every SKU shown, not once per product', async () => {
    const { ports, asked } = setup();
    await searchCatalog(ports, settings, { query: 'cotton', pagination: page() });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.sort()).toEqual(['MUG-1', 'SCARF-1', 'TEE-L', 'TEE-S']);
    asked.length = 0;
    await lookupCatalog(ports, settings, { ids: ['tee', 'hat', 'ghost'] });
    expect(asked).toHaveLength(1);
  });

  it('flags get_product’s option values by stock: a value is available while a matching variant is', async () => {
    const { ports } = setup();
    const r = await getCatalogProduct(ports, settings, { id: 'tee' });
    const options = (body(r).product as unknown as { options: { values: unknown[] }[] }).options;
    expect(options[0]?.values).toEqual([
      expect.objectContaining({ id: 's', exists: true, available: true }),
      expect.objectContaining({ id: 'l', exists: true, available: false }),
    ]);
  });

  it('reads no stock for a request that shows no product', async () => {
    const { ports, asked } = setup();
    await lookupCatalog(ports, settings, { ids: ['ghost'] });
    expect(asked.flat()).toEqual([]);
  });
});

describe('catalogLocale', () => {
  const channel = { ...CATALOG_CHANNEL, locales: ['en-US', 'es'], defaultLocale: 'en-US' };
  it('matches exactly, then by language, and skips what the channel lacks', () => {
    expect(catalogLocale(channel, ['ES'])).toBe('es');
    expect(catalogLocale(channel, ['en-GB'])).toBe('en-US');
    expect(catalogLocale(channel, [undefined, '*', 'de', 'es-MX'])).toBe('es');
    expect(catalogLocale(channel, ['de'])).toBe('en-US');
  });
});

describe('lookupCatalog', () => {
  it('resolves a SKU and a key, merged, each correlated to its id', async () => {
    const { ports } = setup();
    const r = await lookupCatalog(ports, settings, { ids: ['TEE-L', 'hat', 'tee'] });
    const products = body(r).products as unknown as {
      id: string;
      variants: { id: string; inputs: { id: string; match: string }[] }[];
    }[];
    // The tee is reached by its SKU and by its key: one product, two variants.
    expect(products.map((p) => p.id)).toEqual(['tee', 'hat']);
    expect(products[0]?.variants).toEqual([
      expect.objectContaining({ id: 'TEE-S', inputs: [{ id: 'tee', match: 'featured' }] }),
      expect.objectContaining({ id: 'TEE-L', inputs: [{ id: 'TEE-L', match: 'exact' }] }),
    ]);
    expect(body(r).messages).toBeUndefined();
  });

  it('reads by SKU first and by key only for an id that is no SKU', async () => {
    const { catalog, ports } = setup();
    await lookupCatalog(ports, settings, { ids: ['TEE-L', 'hat'] });
    const reads = catalog.calls.filter((c) => c.method === 'bySku' || c.method === 'doc');
    expect(reads.map((c) => [c.method, c.args[2]])).toEqual([
      ['bySku', 'TEE-L'],
      ['bySku', 'hat'],
      ['doc', 'hat'],
    ]);
  });

  it('finds a product by a GTIN in any length and by its handle, correlated to the id', async () => {
    const gtinTee = doc('gtin-tee', {
      slug: 'plain-tee',
      variants: [
        variant('GT-S', 1000, { gtin: '036000291452' }),
        variant('GT-L', 1100, { gtin: '036000291452' }),
        variant('GT-X', 1200, { gtin: '4006381333931' }),
      ],
    });
    const { catalog, ports } = setup({ docs: { en: [tee, hat, gtinTee] } });
    // A UPC and its GTIN-14 are one item: both name the two variants that carry it.
    const upc = await lookupCatalog(ports, settings, { ids: ['036000291452', '00036000291452'] });
    const shown = body(upc).products as unknown as Shown[];
    expect(shown.map((p) => p.id)).toEqual(['gtin-tee']);
    expect(shown[0]?.variants.map((v) => [v.id, v.inputs])).toEqual([
      [
        'GT-S',
        [
          { id: '036000291452', match: 'exact' },
          { id: '00036000291452', match: 'exact' },
        ],
      ],
      [
        'GT-L',
        [
          { id: '036000291452', match: 'exact' },
          { id: '00036000291452', match: 'exact' },
        ],
      ],
    ]);
    // A handle is its product, the cheapest variant featured, as a key is.
    const byHandle = await lookupCatalog(ports, settings, { ids: ['plain-tee'] });
    expect((body(byHandle).products[0] as unknown as Shown).variants).toEqual([
      expect.objectContaining({ id: 'GT-S', inputs: [{ id: 'plain-tee', match: 'featured' }] }),
    ]);
    expect(catalog.calls.filter((c) => c.method === 'byGtin').map((c) => c.args[2])).toContain(
      '00036000291452',
    );
  });

  it('asks the edge for a GTIN or a handle only for an id that could be one, and last', async () => {
    const { catalog, ports } = setup();
    // A bad check digit is no GTIN (though digits can be a handle), capitals and 201 characters are
    // no handle: they never reach the edge as one.
    const r = await lookupCatalog(ports, settings, {
      ids: ['12345678', 'Not-A-Handle', `${'a'.repeat(201)}`, 'nothing-here', '4006381333931'],
    });
    expect(body(r).products).toEqual([]);
    expect(body(r).messages?.map((m) => m.code)).toEqual(Array(5).fill('not_found'));
    expect(catalog.calls.filter((c) => c.method === 'byGtin').map((c) => c.args[2])).toEqual([
      '04006381333931',
    ]);
    expect(catalog.calls.filter((c) => c.method === 'bySlug').map((c) => c.args[2])).toEqual([
      '12345678',
      'nothing-here',
      '4006381333931',
    ]);
  });

  it('prefers a SKU or a key to a GTIN or a handle of the same spelling', async () => {
    const clash = doc('clash', { slug: 'hat', variants: [variant('CL-1', 500)] });
    const { ports } = setup({ docs: { en: [hat, clash] } });
    const r = await lookupCatalog(ports, settings, { ids: ['hat'] });
    expect((body(r).products as unknown as Shown[]).map((p) => p.id)).toEqual(['hat']);
  });

  it('shows a product no longer published as not found: the edge has no alias for it', async () => {
    const { ports } = setup({ docs: { en: [] } });
    const r = await lookupCatalog(ports, settings, { ids: ['tee', 'TEE-S', '4006381333931'] });
    expect(body(r).products).toEqual([]);
    expect(body(r).messages?.map((m) => m.code)).toEqual(['not_found', 'not_found', 'not_found']);
  });

  it('says which ids matched nothing, including ones the edge would refuse', async () => {
    const { catalog, ports } = setup();
    const r = await lookupCatalog(ports, settings, { ids: ['hat', 'ghost', '../etc', 'a b'] });
    expect(body(r).products.map((p) => p.id)).toEqual(['hat']);
    expect(body(r).messages?.map((m) => [m.code, m.path])).toEqual([
      ['not_found', '$.ids[1]'],
      ['not_found', '$.ids[2]'],
      ['not_found', '$.ids[3]'],
    ]);
    // An id that isn't a code never reaches the edge.
    const asked = catalog.calls.filter((c) => c.method === 'doc').map((c) => c.args[2]);
    expect(asked).not.toContain('../etc');
    expect(asked).not.toContain('a b');
  });

  it('applies the filters: a category drops a product, a price range its variants', async () => {
    const { ports } = setup();
    const byCategory = await lookupCatalog(ports, settings, {
      ids: ['tee', 'hat'],
      filters: { categories: ['accessories'] },
    });
    expect(body(byCategory).products.map((p) => p.id)).toEqual(['hat']);
    const byPrice = await lookupCatalog(ports, settings, {
      ids: ['tee'],
      filters: { price: { min: 2000 } },
    });
    const variants = (body(byPrice).products[0] as unknown as { variants: { id: string }[] })
      .variants;
    // The tee's other variant is under the range, so the key resolves to the one left.
    expect(variants.map((v) => v.id)).toEqual(['TEE-L']);
  });

  it('is empty for a product with nothing priced in the channel’s currency', async () => {
    const { ports } = setup();
    const r = await lookupCatalog(ports, settings, { ids: ['scarf'] });
    expect(body(r).products).toEqual([]);
    expect(body(r).messages).toMatchObject([{ code: 'not_found' }]);
  });
});

describe('getCatalogProduct', () => {
  it('returns a product by key with its options narrowed by the selection', async () => {
    const { ports } = setup();
    const r = await getCatalogProduct(ports, settings, {
      id: 'tee',
      selected: [{ name: 'Size', label: 'Large' }],
    });
    const product = body(r) as unknown as {
      product: {
        id: string;
        selected: unknown[];
        options: { values: { id: string; exists: boolean }[] }[];
      };
    };
    expect(product.product.id).toBe('tee');
    expect(product.product.selected).toEqual([{ name: 'Size', id: 'l', label: 'Large' }]);
  });

  it('takes a SKU too, and anchors the selection on that variant', async () => {
    const { ports } = setup();
    const r = await getCatalogProduct(ports, settings, { id: 'TEE-S' });
    const product = (body(r) as unknown as { product: { id: string; selected: { id: string }[] } })
      .product;
    expect(product.id).toBe('tee');
    expect(product.selected).toEqual([expect.objectContaining({ id: 's' })]);
  });

  it('prefers a key to a SKU of the same spelling', async () => {
    const clash = doc('TEE-S', { title: 'A product keyed like a SKU' });
    const { ports } = setup({ docs: { en: [tee, clash] } });
    const r = await getCatalogProduct(ports, settings, { id: 'TEE-S' });
    expect((body(r) as unknown as { product: { id: string } }).product.id).toBe('TEE-S');
  });

  it('answers an unknown, malformed or other-currency id with an error response, not a failure', async () => {
    const { catalog, ports } = setup();
    for (const id of ['ghost', '../etc', 'scarf']) {
      const r = await getCatalogProduct(ports, settings, { id });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        ucp: { status: 'error' },
        messages: [{ code: 'not_found', path: '$.id' }],
      });
    }
    expect(catalog.calls.some((c) => c.args.includes('../etc'))).toBe(false);
  });

  it('honours a category filter', async () => {
    const { ports } = setup();
    const r = await getCatalogProduct(ports, settings, {
      id: 'tee',
      filters: { categories: ['home'] },
    });
    expect(r.body).toMatchObject({ ucp: { status: 'error' } });
  });
});
