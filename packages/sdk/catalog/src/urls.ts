/**
 * The URLs the client asks for, built in the edge's canonical form (`canonical` in the delivery
 * app's `routes.ts`): the same path, the same parameter order and the same encoding, so every
 * request lands on the one cache entry the gateway would have forwarded it to. A parity test parses
 * each URL back through the edge's own parser. Input the edge would refuse is a `TypeError` here.
 */
import {
  BATCH_MAX,
  CODE,
  LOCALE,
  MAX_FILTERS,
  MAX_VALUES,
  NUMBER,
  PAGE,
  QUERY_MAX,
  SEARCH_DEPTH,
  SLUG,
  SLUG_MAX,
  SORT,
} from './generated/limits.js';

export interface ListingQuery {
  /** Products having any of these values, per attribute (`{ brand: ['acme'] }`); attributes all have to match. */
  readonly filters?: Readonly<Record<string, readonly string[]>>;
  /** Inclusive numeric ranges, either end optional (`{ price: { min: 1000 } }`). */
  readonly ranges?: Readonly<Record<string, { readonly min?: number; readonly max?: number }>>;
  /** `newest` (default), or `<attr>_asc` / `<attr>_desc`. */
  readonly sort?: string;
  /** The previous page's `next`, passed back exactly as it came. */
  readonly cursor?: string | null;
  /** 1 to 100; 24 by default. */
  readonly limit?: number;
}

export interface SearchQuery {
  /** The previous page's `next` (an offset below 1,000). */
  readonly cursor?: number;
  /** 1 to 100; 24 by default. */
  readonly limit?: number;
}

function need(ok: boolean, what: string): void {
  if (!ok) throw new TypeError(what);
}

/** The base every URL hangs from: `<origin>/v1/<channel>/<locale>`. */
export function baseUrl(origin: string, channel: string, locale: string): string {
  need(CODE.test(channel), `bad channel "${channel}"`);
  need(LOCALE.test(locale), `bad locale "${locale}"`);
  return `${origin.replace(/\/+$/, '')}/v1/${channel}/${locale}`;
}

export const productUrl = (base: string, key: string): string => {
  need(CODE.test(key), `bad product key "${key}"`);
  return `${base}/products/${key}`;
};

export function batchUrl(base: string, keys: readonly string[]): string {
  const unique = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
  need(unique.length > 0, 'keys is required');
  need(unique.length <= BATCH_MAX, `at most ${BATCH_MAX} keys`);
  for (const k of unique) need(CODE.test(k), `bad product key "${k}"`);
  return `${base}/products?keys=${unique.join(',')}`;
}

export const skuUrl = (base: string, sku: string): string => {
  need(CODE.test(sku), `bad sku "${sku}"`);
  return `${base}/skus/${sku}`;
};

export const slugUrl = (base: string, slug: string): string => {
  need(slug.length <= SLUG_MAX && SLUG.test(slug), `bad slug "${slug}"`);
  return `${base}/slugs/${encodeURIComponent(slug)}`;
};

export const categoriesUrl = (base: string): string => `${base}/categories`;

function limitParam(limit: number | undefined): number {
  const n = limit ?? PAGE.default;
  need(Number.isInteger(n) && n >= 1 && n <= PAGE.max, `limit is 1 to ${PAGE.max}`);
  return n;
}

/** The form a search query is cached under: folded, single-spaced and capped, as the edge does it. */
export function normalizeQuery(q: string): string {
  return q.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX).trim();
}

export function searchUrl(base: string, q: string, query: SearchQuery = {}): string {
  const normalized = normalizeQuery(q);
  need(/[\p{L}\p{N}]/u.test(normalized), 'q needs a word');
  const cursor = query.cursor ?? 0;
  need(
    Number.isSafeInteger(cursor) && cursor >= 0 && cursor < SEARCH_DEPTH,
    `cursor is 0 to ${SEARCH_DEPTH - 1}`,
  );
  const limit = limitParam(query.limit);
  const params = new URLSearchParams({ q: normalized });
  if (cursor) params.set('cursor', String(cursor));
  if (limit !== PAGE.default) params.set('limit', String(limit));
  return `${base}/search?${params}`;
}

export function listingUrl(base: string, category: string, query: ListingQuery = {}): string {
  need(CODE.test(category), `bad category "${category}"`);
  // Filters in name order, values sorted and unique: every equivalent page shares one cache entry.
  const params = new URLSearchParams();
  const terms: [string, string[]][] = [];
  for (const [attr, raw] of Object.entries(query.filters ?? {})) {
    need(CODE.test(attr), `bad filter "${attr}"`);
    const values = [...new Set(raw.map((v) => v.trim()).filter(Boolean))].sort();
    for (const v of values) need(!v.includes(','), `filter ${attr}: a value can't hold a comma`);
    need(values.length <= MAX_VALUES, `at most ${MAX_VALUES} values in filter ${attr}`);
    if (values.length) terms.push([attr, values]);
  }
  const ranges: [string, string][] = [];
  for (const [attr, { min, max }] of Object.entries(query.ranges ?? {})) {
    need(CODE.test(attr), `bad range "${attr}"`);
    if (min === undefined && max === undefined) continue;
    const [lo, hi] = [min, max].map((n) => (n === undefined ? '' : String(n)));
    for (const bound of [lo, hi]) need(!bound || NUMBER.test(bound), `bad range ${attr}`);
    ranges.push([attr, `${lo}..${hi}`]);
  }
  need(terms.length + ranges.length <= MAX_FILTERS, `at most ${MAX_FILTERS} filters`);
  for (const [attr, values] of terms.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    params.set(`f.${attr}`, values.join(','));
  for (const [attr, range] of ranges.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    params.set(`r.${attr}`, range);
  const sort = query.sort ?? 'newest';
  need(SORT.test(sort), `bad sort "${sort}"`);
  if (sort !== 'newest') params.set('sort', sort);
  if (query.cursor) params.set('cursor', query.cursor);
  const limit = limitParam(query.limit);
  if (limit !== PAGE.default) params.set('limit', String(limit));
  const qs = params.toString();
  return `${base}/categories/${category}/products${qs ? `?${qs}` : ''}`;
}
