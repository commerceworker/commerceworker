/**
 * The cache only helps if the client asks for exactly what the edge would forward. Every URL the
 * client builds is parsed by the edge's own `parse` and must come back as the same request, and
 * `canonical` of that request must be the URL itself (bar the host). The edge's source is imported
 * here only: it never ships in the client.
 */
import { encodeListingCursor, LISTING_SEGMENTS } from '@commerceworker/core/product/listing';
import { normalizeQuery as coreNormalizeQuery } from '@commerceworker/core/product/search';
import { describe, expect, it } from 'vitest';
import { canonical, parse, type Route } from '../../../../apps/delivery/src/catalog/routes';
import {
  baseUrl,
  batchUrl,
  categoriesUrl,
  type ListingQuery,
  listingUrl,
  normalizeQuery,
  productUrl,
  type SearchQuery,
  searchUrl,
  skuUrl,
  slugUrl,
} from '../src/urls';

/** A cursor at `pos` in the first segment, spelled as the edge issues it. */
const cursorAt = (pos: number) =>
  encodeListingCursor([pos, ...Array<number>(LISTING_SEGMENTS - 1).fill(0)]);

const ORIGIN = 'https://catalog.example.com';
const base = baseUrl(`${ORIGIN}/`, 'web', 'en-US');

function route(url: string): Route {
  const parsed = parse(new URL(url));
  if (!parsed.ok) throw new Error(`${url} refused: ${parsed.error}`);
  // The gateway forwards canonical(route) on its internal host; only that host differs.
  expect(canonical(parsed.route).replace('https://catalog.internal', ORIGIN), url).toBe(url);
  return parsed.route;
}

describe('the client builds the edge’s canonical urls', () => {
  it('product, sku, slug and categories', () => {
    expect(route(productUrl(base, 'tee-1'))).toMatchObject({ kind: 'product', key: 'tee-1' });
    expect(route(skuUrl(base, 'SKU.9_a'))).toMatchObject({ kind: 'sku', sku: 'SKU.9_a' });
    expect(route(categoriesUrl(base))).toMatchObject({ kind: 'categories' });
    expect(route(slugUrl(base, 'blue-cotton-tee'))).toMatchObject({
      kind: 'slug',
      slug: 'blue-cotton-tee',
    });
    // A slug in another script is percent-encoded the way canonical() writes it.
    expect(route(slugUrl(base, 'café-bleu'))).toMatchObject({ slug: 'café-bleu' });
    expect(route(slugUrl(base, '蓝色-衬衫'))).toMatchObject({ slug: '蓝色-衬衫' });
  });

  it('a batch keeps the order asked and drops duplicates and blanks', () => {
    const url = batchUrl(base, ['b', ' a ', 'b', '', 'c']);
    expect(url).toBe(`${base}/products?keys=b,a,c`);
    expect(route(url)).toMatchObject({ kind: 'batch', keys: ['b', 'a', 'c'] });
    const hundred = Array.from({ length: 100 }, (_, i) => `k${i}`);
    expect(route(batchUrl(base, hundred))).toMatchObject({ keys: hundred });
  });

  const searches: [string, SearchQuery | undefined][] = [
    ['shirt', undefined],
    ['Blue  Cotton TEE ', undefined],
    ['blue cott', { cursor: 24, limit: 24 }],
    ['café', { limit: 100 }],
    ['a&b=c d+e', { cursor: 999, limit: 1 }],
    ['ÉCOLE ﬁn', { cursor: 0 }],
    ['x'.repeat(300), undefined],
    ['日本語 シャツ', { limit: 5 }],
  ];
  it.each(searches)('search %j %j', (q, query) => {
    const r = route(searchUrl(base, q, query));
    expect(r).toMatchObject({
      kind: 'search',
      q: normalizeQuery(q),
      cursor: query?.cursor ?? 0,
      limit: query?.limit ?? 24,
    });
  });

  it('normalizes a query exactly as core does', () => {
    for (const q of [
      'Blue  Cotton',
      '  padded  ',
      'ÉCOLE',
      'ﬁ ligature',
      'tab\tand\nnewline',
      'x'.repeat(150),
      `${'word '.repeat(30)}tail`,
      'a '.repeat(60),
    ])
      expect(normalizeQuery(q), q).toBe(coreNormalizeQuery(q));
  });

  const listings: [string, ListingQuery | undefined][] = [
    ['shirts', undefined],
    ['shirts', { filters: { brand: ['acme'] } }],
    // Names and values come out sorted whatever order they went in, and values are unique.
    ['shirts', { filters: { size: ['m', 'l', 'm', ' s '], brand: ['zed', 'acme'] } }],
    ['shirts', { filters: { size: [] } }],
    ['shirts', { ranges: { price: { min: 1000 } } }],
    ['shirts', { ranges: { price: { max: 5000.5 }, weight: { min: -3, max: 12 } } }],
    ['shirts', { ranges: { price: {} } }],
    ['shirts', { sort: 'price_asc', limit: 50 }],
    ['shirts', { sort: 'newest' }],
    [
      'shirts',
      { filters: { color: ['red', 'blue'] }, ranges: { price: { min: 1 } }, sort: 'price_desc' },
    ],
    ['shirts', { limit: 24 }],
    ['shirts', { limit: 100 }],
    ['shirts', { filters: { 'a.b-c_d': ['x y', 'p&q', 'ü'] } }],
    ['sh.irts-2', { cursor: cursorAt(3), limit: 10 }],
  ];
  it.each(listings)('listing %s %j', (category, query) => {
    const url = listingUrl(base, category, query);
    const r = route(url);
    expect(r).toMatchObject({ kind: 'listing', category });
    if (r.kind !== 'listing') return;
    expect(r.sort).toBe(query?.sort ?? 'newest');
    expect(r.limit).toBe(query?.limit ?? 24);
  });

  it('carries a filter’s values and a range’s bounds through the parser', () => {
    const r = route(
      listingUrl(base, 'shirts', {
        filters: { size: ['m', 'l', 'm'], brand: ['acme'] },
        ranges: { price: { min: 1000 }, weight: { max: 2.5 } },
      }),
    );
    if (r.kind !== 'listing') throw new Error('not a listing');
    expect(r.terms).toEqual({ brand: ['acme'], size: ['l', 'm'] });
    expect(r.ranges).toEqual({ price: [1000, null], weight: [null, 2.5] });
  });

  it('a cursor the edge issued is forwarded untouched', () => {
    const next = cursorAt(24);
    const r = route(listingUrl(base, 'shirts', { cursor: next }));
    expect(r).toMatchObject({ kind: 'listing', cursor: next });
  });
});

describe('what the edge refuses, the client refuses first', () => {
  const refused: [string, () => string][] = [
    ['channel', () => baseUrl(ORIGIN, 'bad channel', 'en')],
    ['locale', () => baseUrl(ORIGIN, 'web', 'EN_us')],
    ['product key', () => productUrl(base, 'a/b')],
    ['sku', () => skuUrl(base, '')],
    ['slug', () => slugUrl(base, 'Upper-Case')],
    ['slug length', () => slugUrl(base, 'a'.repeat(201))],
    ['no keys', () => batchUrl(base, [])],
    [
      'too many keys',
      () =>
        batchUrl(
          base,
          Array.from({ length: 101 }, (_, i) => `k${i}`),
        ),
    ],
    ['bad key in keys', () => batchUrl(base, ['ok', 'no good'])],
    ['empty query', () => searchUrl(base, '  !!  ')],
    ['search cursor', () => searchUrl(base, 'x', { cursor: 1000 })],
    ['search limit', () => searchUrl(base, 'x', { limit: 101 })],
    ['category', () => listingUrl(base, 'a b')],
    ['sort', () => listingUrl(base, 'c', { sort: 'cheapest' })],
    ['listing limit', () => listingUrl(base, 'c', { limit: 0 })],
    ['filter name', () => listingUrl(base, 'c', { filters: { 'a b': ['x'] } })],
    ['a comma in a value', () => listingUrl(base, 'c', { filters: { a: ['x,y'] } })],
    [
      'too many values',
      () =>
        listingUrl(base, 'c', { filters: { a: Array.from({ length: 51 }, (_, i) => `v${i}`) } }),
    ],
    [
      'too many filters',
      () =>
        listingUrl(base, 'c', {
          filters: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`a${i}`, ['x']])),
        }),
    ],
    ['range bound', () => listingUrl(base, 'c', { ranges: { price: { min: Number.NaN } } })],
    ['exponent bound', () => listingUrl(base, 'c', { ranges: { price: { max: 1e21 } } })],
  ];
  it.each(refused)('%s is a TypeError', (_name, build) => {
    expect(build).toThrow(TypeError);
  });

  it('and the edge refuses the same spellings', () => {
    for (const url of [
      `${base}/products/a%2Fb`,
      `${base}/slugs/Upper-Case`,
      `${base}/search?q=%21%21`,
      `${base}/search?q=x&cursor=1000`,
      `${base}/search?q=x&limit=101`,
      `${base}/categories/c/products?sort=cheapest`,
      `${base}/categories/c/products?limit=0`,
      `${base}/categories/c/products?r.price=a..b`,
    ])
      expect(parse(new URL(url)).ok, url).toBe(false);
  });
});
