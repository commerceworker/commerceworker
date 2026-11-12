/**
 * UCP catalog search and lookup (`search_catalog`, `lookup_catalog`, `get_product`): what a
 * platform's agent sees of the catalog before it starts a checkout. Reads published documents
 * through the `CatalogReader` port, in the one channel the catalog feeds orders from, in that
 * channel's currency, and maps them with core's `ucp/catalog` (which names every field that leaves).
 * Read-only: nothing is stored, and a request's `context` and `signals` are read for the currency
 * and language only, never kept or logged.
 *
 * A protocol failure (a cursor that isn't ours) is `{ status: 400, body: { code, content } }`; every
 * other outcome is 200 with the UCP envelope, `messages` saying what was ignored or couldn't be
 * found, and an error response when there is no resource at all.
 */
import {
  decodeCursor,
  encodeCursor,
  lookupProducts,
  paginate,
  toUcpDetailProduct,
  toUcpProduct,
  type UcpCatalogContext,
  type UcpGetProductInput,
  type UcpLookupInput,
  type UcpSearchInput,
  ucpCatalogEnvelope,
  ucpError,
  ucpErrorResponse,
  ucpMessage,
} from '@commerceworker/core';
import {
  CODE,
  decodeListingCursor,
  normalizeQuery,
  queryTerms,
  SEARCH_DEPTH,
} from '@commerceworker/core/product';
import type { CatalogChannel, CatalogDoc, CatalogReader } from '@commerceworker/ports/commerce';

export type UcpCatalogPorts = { catalog: CatalogReader };

/** What a deployment's UCP settings say about catalog results. */
export type UcpCatalogSettings = { productUrl: string | null };

/** The status and body the engine sends. */
export type UcpCatalogResult = { status: number; body: Record<string, unknown> };

/**
 * Best matches a filtered search looks at. Keyword search can't filter by category or price, so
 * the edge's best matches are fetched and filtered here: bounded, since each is a document read.
 */
export const SEARCH_WINDOW = 50;

type Filters = { categories?: string[]; price?: { min?: number; max?: number } };
type Issue = Parameters<typeof ucpMessage>[0];
type Context = { currency?: string; language?: string };

/**
 * The channel's locale a request asks for: the first of `wanted` (the context's language, then the
 * Accept-Language tags in order) that a locale of the channel matches exactly or by language, else
 * the channel's default.
 */
export function catalogLocale(
  channel: Pick<CatalogChannel, 'locales' | 'defaultLocale'>,
  wanted: readonly (string | undefined)[],
): string {
  for (const tag of wanted) {
    const t = tag?.trim().toLowerCase();
    if (!t || t === '*') continue;
    const exact = channel.locales.find((l) => l.toLowerCase() === t);
    if (exact) return exact;
    const language = t.split('-')[0];
    const byLanguage = channel.locales.find((l) => l.toLowerCase().split('-')[0] === language);
    if (byLanguage) return byLanguage;
  }
  return channel.defaultLocale;
}

type Prepared = {
  channel: CatalogChannel;
  locale: string;
  issues: Issue[];
  /** The price range to apply, or undefined when there is none or it can't be (another currency). */
  price: { min?: number; max?: number } | undefined;
  /** A product's mapping context: its type's option names in the response's locale. */
  forDoc(doc: CatalogDoc): Promise<UcpCatalogContext>;
};

async function prepare(
  ports: UcpCatalogPorts,
  settings: UcpCatalogSettings,
  request: { context?: Context; filters?: Filters },
  acceptLanguage: readonly string[],
): Promise<Prepared | UcpCatalogResult> {
  const channel = await ports.catalog.channel();
  if (!channel)
    return {
      status: 200,
      body: ucpErrorResponse([
        {
          kind: 'error',
          code: 'catalog_unavailable',
          content: 'This business has no catalog to search.',
          severity: 'unrecoverable',
        },
      ]),
    };
  const locale = catalogLocale(channel, [request.context?.language, ...acceptLanguage]);
  const issues: Issue[] = [];
  let price = request.filters?.price;
  if (request.context?.currency && request.context.currency !== channel.currency) {
    issues.push({
      kind: 'info',
      code: 'currency_unsupported',
      content: `Prices are in ${channel.currency}; ${request.context.currency} isn't offered.`,
    });
    if (price) {
      issues.push({
        kind: 'warning',
        code: 'price_filter_ignored',
        content: `The price filter was ignored: it is in ${request.context.currency} and prices are in ${channel.currency}.`,
        path: '$.filters.price',
      });
      price = undefined;
    }
  }
  if (price && price.min === undefined && price.max === undefined) price = undefined;
  // One read per type, however many products share it.
  const names = new Map<string, Promise<Record<string, string>>>();
  return {
    channel,
    locale,
    issues,
    price,
    forDoc: async (doc) => {
      const known = names.get(doc.type) ?? ports.catalog.axisNames(doc.type, locale);
      names.set(doc.type, known);
      return {
        axisNames: await known,
        currency: channel.currency,
        ...(settings.productUrl ? { productUrl: settings.productUrl } : {}),
      };
    },
  };
}

const isResult = (p: Prepared | UcpCatalogResult): p is UcpCatalogResult => 'status' in p;

/**
 * The document narrowed by a request's filters, or null when nothing of it is left. Categories
 * match the product (any listed one); a price range keeps the variants priced inside it, so the
 * product shows only what the platform asked for.
 */
function narrow(
  doc: CatalogDoc,
  categories: string[],
  price: Prepared['price'],
): CatalogDoc | null {
  if (categories.length && !doc.categories.some((c) => categories.includes(c))) return null;
  if (!price) return doc;
  const { min = 0, max = Number.POSITIVE_INFINITY } = price;
  const variants = doc.variants.filter(
    (v) => v.price && v.price.amount >= min && v.price.amount <= max,
  );
  // The document's own range describes every variant, so it no longer does.
  return variants.length ? { ...doc, variants, priceRange: undefined } : null;
}

const messages = (issues: Issue[]) => (issues.length ? { messages: issues.map(ucpMessage) } : {});

const badCursor = (): UcpCatalogResult => ({
  status: 400,
  body: ucpError('invalid_request', 'The cursor is not valid.'),
});

const noPage = (issues: Issue[]): UcpCatalogResult => ({
  status: 200,
  body: {
    ucp: ucpCatalogEnvelope(),
    products: [],
    pagination: { has_next_page: false },
    ...messages(issues),
  },
});

/** The documents of these keys, in order; a key that has none (unpublished since) is skipped. */
async function docsOf(
  ports: UcpCatalogPorts,
  p: Prepared,
  keys: readonly string[],
): Promise<CatalogDoc[]> {
  const docs = await Promise.all(keys.map((k) => ports.catalog.doc(p.channel.code, p.locale, k)));
  return docs.filter((d): d is CatalogDoc => d !== null);
}

export async function searchCatalog(
  ports: UcpCatalogPorts,
  settings: UcpCatalogSettings,
  input: UcpSearchInput,
  acceptLanguage: readonly string[] = [],
): Promise<UcpCatalogResult> {
  const p = await prepare(ports, settings, input, acceptLanguage);
  if (isResult(p)) return p;
  const categories = [...new Set(input.filters?.categories ?? [])];
  const q = normalizeQuery(input.query ?? '');
  const page = input.pagination;
  const products = async (docs: CatalogDoc[]) => {
    const out = [];
    for (const doc of docs) {
      const narrowed = narrow(doc, categories, p.price);
      const mapped = narrowed && toUcpProduct(narrowed, await p.forDoc(narrowed));
      if (mapped) out.push(mapped);
    }
    return out;
  };

  if (!queryTerms(q).length) {
    const [category] = categories;
    if (categories.length !== 1 || category === undefined)
      return noPage([
        ...p.issues,
        {
          kind: 'info',
          code: 'query_required',
          content: 'Send a query, or exactly one category in filters.categories.',
        },
      ]);
    // The edge's own cursor: opaque to the platform, and checked in its one spelling here.
    if (page.cursor !== undefined && !decodeListingCursor(page.cursor)) return badCursor();
    if (!CODE.test(category)) return noPage(p.issues);
    const listing = await ports.catalog.listing(p.channel.code, p.locale, category, {
      limit: page.limit,
      ...(page.cursor ? { cursor: page.cursor } : {}),
      ...(p.price ? { price: p.price } : {}),
    });
    if (!listing) return noPage(p.issues);
    return {
      status: 200,
      body: {
        ucp: ucpCatalogEnvelope(),
        products: await products(await docsOf(ports, p, listing.keys)),
        pagination: {
          has_next_page: listing.next !== null,
          ...(listing.next !== null ? { cursor: listing.next } : {}),
          total_count: listing.total,
        },
        ...messages(p.issues),
      },
    };
  }

  const offset = decodeCursor(page.cursor);
  if (offset === null) return badCursor();

  if (!categories.length && !p.price) {
    // Nothing to filter by: the edge pages, and the cursor is its offset.
    if (offset >= SEARCH_DEPTH) return noPage(p.issues);
    const hits = await ports.catalog.search(p.channel.code, p.locale, q, {
      limit: page.limit,
      offset,
    });
    return {
      status: 200,
      body: {
        ucp: ucpCatalogEnvelope(),
        products: await products(await docsOf(ports, p, hits.keys)),
        pagination: {
          has_next_page: hits.next !== null,
          ...(hits.next !== null ? { cursor: encodeCursor(hits.next) } : {}),
          total_count: hits.total,
        },
        ...messages([
          ...p.issues,
          ...(hits.partial
            ? [
                {
                  kind: 'info' as const,
                  code: 'search_partial',
                  content: 'Some of the catalog could not be searched; try again shortly.',
                },
              ]
            : []),
        ]),
      },
    };
  }

  const hits = await ports.catalog.search(p.channel.code, p.locale, q, {
    limit: SEARCH_WINDOW,
    offset: 0,
  });
  const kept = await products(await docsOf(ports, p, hits.keys));
  const paged = paginate(kept, page, kept.length);
  if (!paged) return badCursor();
  return {
    status: 200,
    body: {
      ucp: ucpCatalogEnvelope(),
      products: paged.items,
      pagination: paged.pagination,
      ...messages([
        ...p.issues,
        ...(hits.total > SEARCH_WINDOW
          ? [
              {
                kind: 'info' as const,
                code: 'search_window',
                content: `Filters apply to the ${SEARCH_WINDOW} best matches of ${hits.total}.`,
              },
            ]
          : []),
      ]),
    },
  };
}

/** The product a key or a variant SKU names, preferring the key; `viaSku` says which it was. */
async function find(ports: UcpCatalogPorts, p: Prepared, id: string) {
  if (!CODE.test(id)) return null;
  const [byKey, bySku] = await Promise.all([
    ports.catalog.doc(p.channel.code, p.locale, id),
    ports.catalog.bySku(p.channel.code, p.locale, id),
  ]);
  return byKey ? { doc: byKey, viaSku: false } : bySku ? { doc: bySku, viaSku: true } : null;
}

async function findBySkuFirst(ports: UcpCatalogPorts, p: Prepared, id: string) {
  if (!CODE.test(id)) return null;
  const bySku = await ports.catalog.bySku(p.channel.code, p.locale, id);
  if (bySku) return { doc: bySku, viaSku: true };
  const byKey = await ports.catalog.doc(p.channel.code, p.locale, id);
  return byKey ? { doc: byKey, viaSku: false } : null;
}

export async function lookupCatalog(
  ports: UcpCatalogPorts,
  settings: UcpCatalogSettings,
  input: UcpLookupInput,
  acceptLanguage: readonly string[] = [],
): Promise<UcpCatalogResult> {
  const p = await prepare(ports, settings, input, acceptLanguage);
  if (isResult(p)) return p;
  const categories = [...new Set(input.filters?.categories ?? [])];
  const ids = [...new Set(input.ids)];
  // An id is a SKU or a key. A SKU is tried first and a key only on a miss, so an id costs one edge
  // read when it is a SKU and two when it is a key, not two always; a SKU that is also another
  // product's key resolves to the SKU's product. The same product reached twice is kept once.
  const found = await Promise.all(ids.map((id) => findBySkuFirst(ports, p, id)));
  const docs = new Map<string, CatalogDoc>();
  for (const f of found) if (f && !docs.has(f.doc.key)) docs.set(f.doc.key, f.doc);
  const out = [];
  for (const doc of docs.values()) {
    const narrowed = narrow(doc, categories, p.price);
    if (narrowed) out.push(...lookupProducts([narrowed], ids, await p.forDoc(narrowed)));
  }
  const resolved = new Set(
    out.flatMap((x) => x.variants.flatMap((v) => v.inputs.map((i) => i.id))),
  );
  const missing: Issue[] = ids.flatMap((id, i) =>
    resolved.has(id)
      ? []
      : [
          {
            kind: 'info' as const,
            code: 'not_found',
            content: `No product or variant matches ${JSON.stringify(id)}.`,
            path: `$.ids[${i}]`,
          },
        ],
  );
  return {
    status: 200,
    body: { ucp: ucpCatalogEnvelope(), products: out, ...messages([...p.issues, ...missing]) },
  };
}

export async function getCatalogProduct(
  ports: UcpCatalogPorts,
  settings: UcpCatalogSettings,
  input: UcpGetProductInput,
  acceptLanguage: readonly string[] = [],
): Promise<UcpCatalogResult> {
  const p = await prepare(ports, settings, input, acceptLanguage);
  if (isResult(p)) return p;
  const categories = [...new Set(input.filters?.categories ?? [])];
  const hit = await find(ports, p, input.id);
  const doc = hit && narrow(hit.doc, categories, p.price);
  // A variant's id anchors the selection on that variant's options, unless the platform chose.
  const anchor = hit?.viaSku
    ? Object.entries(hit.doc.variants.find((v) => v.sku === input.id)?.options ?? {}).map(
        ([axis, o]) => ({ name: axis, id: o.code, label: o.label }),
      )
    : [];
  const product =
    doc &&
    toUcpDetailProduct(
      doc,
      input.selected?.length ? input.selected : anchor,
      input.preferences ?? [],
      await p.forDoc(doc),
    );
  if (!product)
    return {
      status: 200,
      body: ucpErrorResponse([
        {
          kind: 'error',
          code: 'not_found',
          content: `No product or variant matches ${JSON.stringify(input.id)}.`,
          path: '$.id',
          severity: 'unrecoverable',
        },
      ]),
    };
  return {
    status: 200,
    body: { ucp: ucpCatalogEnvelope(), product, ...messages(p.issues) },
  };
}
