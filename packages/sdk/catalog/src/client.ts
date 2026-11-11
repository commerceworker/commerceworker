import {
  CatalogConnectionError,
  CatalogTimeoutError,
  errorFor,
  isCatalogApiError,
  isCatalogConnectionError,
} from './errors.js';
import type { Category, ListingPage, ProductCard, ProductDocument, SearchPage } from './types.js';
import {
  baseUrl,
  batchUrl,
  categoriesUrl,
  type ListingQuery,
  listingUrl,
  productUrl,
  type SearchQuery,
  searchUrl,
  skuUrl,
  slugUrl,
} from './urls.js';

export interface CatalogClientOptions {
  /** The catalog's host, e.g. `https://catalog.your-domain.com` (no path). Public: it needs no token. */
  readonly origin: string;
  /** The channel to read, e.g. `web`. */
  readonly channel: string;
  /** The locale text comes back in, e.g. `en` or `en-US`. */
  readonly locale: string;
  /** Inject a fetch (a Worker's service binding, a test); defaults to the global one. */
  readonly fetch?: typeof fetch;
  /** Give up on a request after this long (each attempt), with a `CatalogTimeoutError`. Default: never. */
  readonly timeoutMs?: number;
  /**
   * How often to resend a request that failed with a 429, a 5xx or a connection error. Default 2;
   * 0 turns retries off. Every request is a public GET, so every one is safe to resend. Waits grow
   * exponentially with jitter, and a `Retry-After` is honored (one over a minute is not waited for:
   * the error is thrown).
   */
  readonly maxRetries?: number;
}

export interface CallOptions {
  /** Aborts the request; the abort error is thrown as it is and never retried. */
  readonly signal?: AbortSignal;
  /** Overrides the client's `timeoutMs` for this call. */
  readonly timeoutMs?: number;
  /** Overrides the client's `maxRetries` for this call. */
  readonly maxRetries?: number;
}

export interface CatalogClient {
  /** A product by key. */
  product(key: string, options?: CallOptions): Promise<ProductDocument>;
  /** Up to 100 listing cards in the order asked; `null` for a key that isn't published. */
  products(
    keys: readonly string[],
    options?: CallOptions,
  ): Promise<{ products: (ProductCard | null)[] }>;
  /** The product holding a variant SKU. */
  sku(sku: string, options?: CallOptions): Promise<ProductDocument>;
  /** The product with a slug in this client's locale. */
  slug(slug: string, options?: CallOptions): Promise<ProductDocument>;
  /** The whole category tree, flat. */
  categories(options?: CallOptions): Promise<{ categories: Category[] }>;
  /** One filtered, faceted, sorted page of a category. */
  listing(category: string, query?: ListingQuery, options?: CallOptions): Promise<ListingPage>;
  /** Every page of a listing, requesting the next as you go. `query.cursor` starts it midway. */
  listingPages(
    category: string,
    query?: ListingQuery,
    options?: CallOptions,
  ): AsyncGenerator<ListingPage, void, undefined>;
  /** Keyword search, best match first. */
  search(q: string, query?: SearchQuery, options?: CallOptions): Promise<SearchPage>;
  /** Every page of a search (up to its 1,000-result depth), requesting the next as you go. */
  searchPages(
    q: string,
    query?: SearchQuery,
    options?: CallOptions,
  ): AsyncGenerator<SearchPage, void, undefined>;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const MAX_RETRY_AFTER_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Full jitter: anywhere up to the exponential step, so retrying clients spread out. */
const backoffMs = (attempt: number) =>
  Math.random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);

export function createCatalogClient(options: CatalogClientOptions): CatalogClient {
  // Checked up front, so a bad channel or locale fails at construction, not on the first read.
  const base = baseUrl(options.origin, options.channel, options.locale);
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  /** `build` runs inside, so a request the edge would refuse rejects the promise rather than throwing at the call. */
  async function get<T>(
    operation: string,
    build: () => string,
    opts: CallOptions = {},
  ): Promise<T> {
    const url = build();
    const timeoutMs = opts.timeoutMs ?? options.timeoutMs;
    const maxRetries = opts.maxRetries ?? options.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      let failure: unknown;
      let waitMs: number | undefined;
      try {
        return (await attemptOnce(operation, url, opts.signal, timeoutMs)) as T;
      } catch (err) {
        failure = err;
        if (isCatalogApiError(err)) {
          if (err.status !== 429 && err.status < 500) throw err;
          if (err.retryAfterSec !== undefined) {
            if (err.retryAfterSec * 1000 > MAX_RETRY_AFTER_MS) throw err;
            waitMs = err.retryAfterSec * 1000;
          }
        } else if (!isCatalogConnectionError(err)) throw err;
      }
      if (attempt >= maxRetries) throw failure;
      await sleep(waitMs ?? backoffMs(attempt));
    }
  }

  /** One request, its failures as `CatalogError`s. A caller's abort is rethrown untouched. */
  async function attemptOnce(
    operation: string,
    url: string,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);
    try {
      // No headers: a browser sends this as a simple request, with no CORS preflight.
      const res = await doFetch(url, { method: 'GET', signal: controller.signal });
      const parsed = await readBody(res);
      if (!res.ok) throw errorFor(res.status, parsed, res.headers);
      return parsed;
    } catch (err) {
      if (isCatalogApiError(err)) throw err;
      if (timedOut)
        throw new CatalogTimeoutError(`${operation} timed out after ${timeoutMs}ms`, {
          cause: err,
        });
      if (signal?.aborted) throw err;
      throw new CatalogConnectionError(
        `${operation} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    product: (key, o) => get('product', () => productUrl(base, key), o),
    products: (keys, o) => get('products', () => batchUrl(base, keys), o),
    sku: (sku, o) => get('sku', () => skuUrl(base, sku), o),
    slug: (slug, o) => get('slug', () => slugUrl(base, slug), o),
    categories: (o) => get('categories', () => categoriesUrl(base), o),
    listing: (category, query, o) => get('listing', () => listingUrl(base, category, query), o),
    search: (q, query, o) => get('search', () => searchUrl(base, q, query), o),

    async *listingPages(category, query = {}, o) {
      let cursor = query.cursor || undefined;
      do {
        const page = await get<ListingPage>(
          'listing',
          () => listingUrl(base, category, { ...query, cursor }),
          o,
        );
        yield page;
        // A cursor the server repeats ends the loop rather than spinning on it.
        cursor = page.next && page.next !== cursor ? page.next : undefined;
      } while (cursor !== undefined);
    },

    async *searchPages(q, query = {}, o) {
      let cursor = query.cursor ?? 0;
      for (;;) {
        const page = await get<SearchPage>(
          'search',
          () => searchUrl(base, q, { ...query, cursor }),
          o,
        );
        yield page;
        if (page.next === null || page.next <= cursor) return;
        cursor = page.next;
      }
    },
  };
}
