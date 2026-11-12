/**
 * A `CatalogReader` over the catalog's read edge: the delivery Worker's `CatalogDelivery`
 * entrypoint, bound as a service (`CATALOG_EDGE`), plus the catalog's own RPC for what the edge
 * doesn't publish (the channel UCP shows, and the names of a type's option axes).
 *
 * Every read is a `fetch` of the edge's canonical URL (`apps/delivery/src/catalog/routes.ts`,
 * `canonical`), so it shares Workers Caching entries with the public edge: the same query in the
 * same spelling is one entry. The host is a placeholder, since a service binding isn't routed by
 * it. A URL is built only from encoded parts and the edge parses it again, so nothing a caller
 * sends can name another route.
 */
import type {
  CatalogChannel,
  CatalogDoc,
  CatalogListingPage,
  CatalogReader,
  CatalogSearchPage,
} from '@commerceworker/ports/commerce';

/** A service binding, as far as this adapter uses it. */
export interface CatalogEdgeFetcher {
  fetch(request: Request): Promise<Response>;
}

/** The catalog's RPC (`ProductCatalogRpc`), as far as this adapter uses it. */
export interface CatalogRpcLike {
  ordersChannel(): Promise<string>;
  listChannels(): Promise<
    { code: string; currency: string; defaultLocale: string; locales: string[] }[]
  >;
  listTypes(): Promise<
    {
      code: string;
      attributes: { code: string; label?: Record<string, string> }[];
      variantAxes: string[];
    }[]
  >;
}

/** The edge answered with something other than a document, a miss or a page. */
export class CatalogEdgeError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`catalog edge: ${what} answered ${status}`);
    this.name = 'CatalogEdgeError';
  }
}

/**
 * The edge's own patterns for a channel, key, SKU or category code and for a locale
 * (`CODE` and `LOCALE`, `@commerceworker/core/product/paths`). Anything else is not asked for: a `.` or
 * `..` would otherwise survive encoding as a dot segment and be resolved by URL parsing into another
 * route. The edge validates too; this keeps the request from being made.
 */
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const valid = (channel: string, locale: string, ...codes: string[]) =>
  CODE.test(channel) && LOCALE.test(locale) && codes.every((c) => CODE.test(c));

/** Lets go of a body nobody will read. Not awaited: a cancel can wait on a body's other readers. */
const discard = (response: Response) => void response.body?.cancel().catch(() => undefined);

/** The edge's default page; a URL names a limit only when it differs, as `canonical` does. */
const EDGE_PAGE = 24;
/** How long a channel or the types are kept: both change when an admin edits the catalog. */
const META_TTL_MS = 30_000;

export interface CatalogEdgeOptions {
  edge: CatalogEdgeFetcher;
  rpc: CatalogRpcLike;
  /** Milliseconds, for the metadata cache. */
  now?: () => number;
}

export function createCatalogEdgeReader(options: CatalogEdgeOptions): CatalogReader {
  const { edge, rpc } = options;
  const now = options.now ?? Date.now;
  let channelCache: { at: number; value: CatalogChannel | null } | undefined;
  let typeCache:
    | { at: number; value: Map<string, Record<string, Record<string, string>>> }
    | undefined;

  const base = (channel: string, locale: string) =>
    `https://catalog.internal/v1/${encodeURIComponent(channel)}/${encodeURIComponent(locale)}`;

  /** The edge's answer as JSON; null for a 404 (nothing published there), an error for the rest. */
  async function read<T>(path: string): Promise<T | null> {
    const response = await edge.fetch(new Request(path));
    if (response.status === 404) {
      discard(response);
      return null;
    }
    if (!response.ok) {
      discard(response);
      throw new CatalogEdgeError(response.status, new URL(path).pathname.split('/')[4] ?? 'a read');
    }
    return (await response.json()) as T;
  }

  const label = (labels: Record<string, string> | undefined, locale: string, code: string) =>
    labels?.[locale] ??
    labels?.[locale.split('-')[0] ?? ''] ??
    Object.values(labels ?? {})[0] ??
    code;

  async function types() {
    if (typeCache && now() - typeCache.at < META_TTL_MS) return typeCache.value;
    const byType = new Map<string, Record<string, Record<string, string>>>();
    for (const t of await rpc.listTypes()) {
      const axes: Record<string, Record<string, string>> = {};
      for (const axis of t.variantAxes) {
        const labels = t.attributes.find((a) => a.code === axis)?.label;
        if (labels) axes[axis] = labels;
      }
      byType.set(t.code, axes);
    }
    typeCache = { at: now(), value: byType };
    return byType;
  }

  return {
    async channel() {
      if (channelCache && now() - channelCache.at < META_TTL_MS) return channelCache.value;
      const [code, channels] = await Promise.all([rpc.ordersChannel(), rpc.listChannels()]);
      const found = channels.find((c) => c.code === code);
      const value = found
        ? {
            code: found.code,
            currency: found.currency,
            defaultLocale: found.defaultLocale,
            locales: [...found.locales],
          }
        : null;
      channelCache = { at: now(), value };
      return value;
    },

    async search(channel, locale, q, page): Promise<CatalogSearchPage> {
      if (!valid(channel, locale)) return { total: 0, keys: [], next: null, partial: false };
      const query = new URLSearchParams({ q });
      if (page.offset) query.set('cursor', String(page.offset));
      if (page.limit !== EDGE_PAGE) query.set('limit', String(page.limit));
      const r = await read<{
        total: number;
        next: number | null;
        products: { key: string }[];
        partial?: true;
      }>(`${base(channel, locale)}/search?${query}`);
      if (!r) return { total: 0, keys: [], next: null, partial: false };
      return {
        total: r.total,
        keys: r.products.map((p) => p.key),
        next: r.next,
        partial: r.partial === true,
      };
    },

    async listing(channel, locale, category, page): Promise<CatalogListingPage | null> {
      if (!valid(channel, locale, category)) return null;
      const query = new URLSearchParams();
      const { min, max } = page.price ?? {};
      if (min !== undefined || max !== undefined)
        query.set('r.price', `${min ?? ''}..${max ?? ''}`);
      if (page.cursor) query.set('cursor', page.cursor);
      if (page.limit !== EDGE_PAGE) query.set('limit', String(page.limit));
      const suffix = query.toString();
      const r = await read<{ total: number; next: string | null; products: { key: string }[] }>(
        `${base(channel, locale)}/categories/${encodeURIComponent(category)}/products${suffix ? `?${suffix}` : ''}`,
      );
      return r && { total: r.total, keys: r.products.map((p) => p.key), next: r.next };
    },

    doc: async (channel, locale, key) =>
      valid(channel, locale, key)
        ? read<CatalogDoc>(`${base(channel, locale)}/products/${encodeURIComponent(key)}`)
        : null,

    bySku: async (channel, locale, sku) =>
      valid(channel, locale, sku)
        ? read<CatalogDoc>(`${base(channel, locale)}/skus/${encodeURIComponent(sku)}`)
        : null,

    async axisNames(type, locale) {
      const [code = ''] = type.split('@');
      const axes = (await types()).get(code) ?? {};
      return Object.fromEntries(
        Object.entries(axes).map(([axis, labels]) => [axis, label(labels, locale, axis)]),
      );
    },
  };
}
