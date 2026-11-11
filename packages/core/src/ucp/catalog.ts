/**
 * UCP catalog search and lookup (`shopping/catalog_search.json`, `catalog_lookup.json`): what a
 * published product document (../product/render.ts) shows an agent. Only display fields leave:
 * title, description, handle, media, price, option values and identifiers. Every output field is
 * named here, so attributes, `extra`, cost, stock and supplier data cannot reach a response by being
 * added to the document. Pure; the engine serves it, and picks the documents.
 */
import { z } from 'zod';
import type { Option, ProductDoc, PublishedVariant } from '../product/render';
import { QUERY_MAX } from '../product/search';
import { UCP_VERSION } from './errors';

type Money = { amount: number; currency: string };
type Range = { min: Money; max: Money };

export type UcpMedia = {
  type: 'image';
  url: string;
  alt_text?: string;
  width?: number;
  height?: number;
};
export type UcpSelectedOption = { name: string; id: string; label: string };
export type UcpVariant = {
  id: string;
  title: string;
  description: { plain: string };
  price: Money;
  sku: string;
  barcodes?: { type: 'GTIN'; value: string }[];
  options?: UcpSelectedOption[];
  media?: UcpMedia[];
};
export type UcpProductOption = { name: string; values: { id: string; label: string }[] };
export type UcpProduct = {
  id: string;
  title: string;
  description: { plain: string };
  handle?: string;
  url?: string;
  categories?: { value: string; taxonomy: 'merchant' }[];
  price_range: Range;
  list_price_range?: Range;
  media?: UcpMedia[];
  options?: UcpProductOption[];
  variants: UcpVariant[];
};
export type UcpLookupVariant = UcpVariant & {
  inputs: { id: string; match: 'exact' | 'featured' }[];
};
export type UcpLookupProduct = Omit<UcpProduct, 'variants'> & { variants: UcpLookupVariant[] };
export type UcpDetailOptionValue = {
  id: string;
  label: string;
  available: boolean;
  exists: boolean;
};
export type UcpDetailProduct = UcpProduct & {
  selected?: UcpSelectedOption[];
  options: { name: string; values: UcpDetailOptionValue[] }[];
};

export type UcpCatalogContext = {
  /** Option axis code → the name shown for it, in the response's locale (from the product type). */
  axisNames: Record<string, string>;
  /** The product page, with `{slug}` and `{key}` filled in. Absent: the response carries no `url`. */
  productUrl?: string;
  /** The currency a response is priced in; a variant priced in another is left out. */
  currency: string;
};

const MEDIA_MAX = 20;

/** An `asset:` reference or anything but an absolute https URL isn't one an agent can fetch. */
function mediaOf(
  list: { src: string; alt?: string; width?: number; height?: number }[] | undefined,
) {
  const out: UcpMedia[] = [];
  for (const m of list ?? []) {
    let url: URL;
    try {
      url = new URL(m.src);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    out.push({
      type: 'image',
      url: url.href,
      ...(m.alt ? { alt_text: m.alt } : {}),
      ...(m.width && m.width >= 1 ? { width: m.width } : {}),
      ...(m.height && m.height >= 1 ? { height: m.height } : {}),
    });
    if (out.length === MEDIA_MAX) break;
  }
  return out.length ? out : undefined;
}

const axisName = (ctx: UcpCatalogContext, code: string) => ctx.axisNames[code] ?? code;

function selectedOptions(v: PublishedVariant, ctx: UcpCatalogContext): UcpSelectedOption[] {
  return Object.entries(v.options).map(([axis, o]) => ({
    name: axisName(ctx, axis),
    id: o.code,
    label: o.label,
  }));
}

/** The variant as an agent adds it to a checkout: `id` is the SKU, the checkout's `item.id`. */
export function toUcpVariant(
  doc: ProductDoc,
  v: PublishedVariant,
  ctx: UcpCatalogContext,
): UcpVariant | null {
  if (v.price?.currency !== ctx.currency) return null;
  const options = selectedOptions(v, ctx);
  const media = mediaOf(v.media);
  return {
    id: v.sku,
    title: options.length ? options.map((o) => o.label).join(' / ') : doc.title,
    description: { plain: doc.description || doc.title },
    price: { amount: v.price.amount, currency: v.price.currency },
    sku: v.sku,
    ...(v.gtin ? { barcodes: [{ type: 'GTIN' as const, value: v.gtin }] } : {}),
    ...(options.length ? { options } : {}),
    ...(media ? { media } : {}),
  };
}

function rangeOf(prices: Money[]): Range {
  let min = prices[0] as Money;
  let max = min;
  for (const m of prices) {
    if (m.amount < min.amount) min = m;
    if (m.amount > max.amount) max = m;
  }
  return { min, max };
}

function productUrl(doc: ProductDoc, template: string | undefined): string | undefined {
  if (!template) return undefined;
  if (template.includes('{slug}') && !doc.slug) return undefined;
  const filled = template
    .replaceAll('{slug}', encodeURIComponent(doc.slug ?? ''))
    .replaceAll('{key}', encodeURIComponent(doc.key));
  try {
    return new URL(filled).protocol === 'https:' ? filled : undefined;
  } catch {
    return undefined;
  }
}

function axisOptions(
  variants: PublishedVariant[],
  ctx: UcpCatalogContext,
): (UcpProductOption & { axis: string })[] {
  const axes = new Map<string, Map<string, Option>>();
  for (const v of variants)
    for (const [axis, o] of Object.entries(v.options)) {
      const values = axes.get(axis) ?? new Map<string, Option>();
      if (!values.has(o.code)) values.set(o.code, o);
      axes.set(axis, values);
    }
  return [...axes].map(([axis, values]) => ({
    axis,
    name: axisName(ctx, axis),
    values: [...values.values()].map((o) => ({ id: o.code, label: o.label })),
  }));
}

/**
 * The product as UCP shows it, or null when no variant is priced in `ctx.currency`: the schema
 * wants a price range and at least one variant, and a price in another currency would mislead.
 */
export function toUcpProduct(doc: ProductDoc, ctx: UcpCatalogContext): UcpProduct | null {
  const kept = doc.variants.filter((v) => v.price?.currency === ctx.currency);
  const variants = kept
    .map((v) => toUcpVariant(doc, v, ctx))
    .filter((v): v is UcpVariant => v !== null);
  if (!variants.length) return null;
  const range =
    doc.priceRange?.min.currency === ctx.currency
      ? doc.priceRange
      : rangeOf(variants.map((v) => v.price));
  const url = productUrl(doc, ctx.productUrl);
  const media = mediaOf(doc.media);
  const options = axisOptions(kept, ctx).map(({ name, values }) => ({ name, values }));
  return {
    id: doc.key,
    title: doc.title,
    description: { plain: doc.description || doc.title },
    ...(doc.slug ? { handle: doc.slug } : {}),
    ...(url ? { url } : {}),
    ...(doc.categories.length
      ? { categories: doc.categories.map((value) => ({ value, taxonomy: 'merchant' as const })) }
      : {}),
    price_range: { min: { ...range.min }, max: { ...range.max } },
    ...(doc.compareAt?.currency === ctx.currency
      ? { list_price_range: { min: { ...doc.compareAt }, max: { ...doc.compareAt } } }
      : {}),
    ...(media ? { media } : {}),
    ...(options.length ? { options } : {}),
    variants,
  };
}

/**
 * Products for a lookup. An id is a variant's SKU (that variant, `exact`) or a product key (its
 * cheapest variant, `featured`, the one an agent would add without asking). Each variant lists every
 * request id that resolved to it; an id that matches nothing is simply absent, which the schema allows.
 */
export function lookupProducts(
  docs: ProductDoc[],
  ids: string[],
  ctx: UcpCatalogContext,
): UcpLookupProduct[] {
  const out: UcpLookupProduct[] = [];
  for (const doc of docs) {
    const product = toUcpProduct(doc, ctx);
    if (!product) continue;
    const hits = new Map<string, UcpLookupVariant['inputs']>();
    const cheapest = product.variants.reduce((a, b) => (b.price.amount < a.price.amount ? b : a));
    for (const id of ids) {
      if (id === doc.key)
        hits.set(cheapest.id, [...(hits.get(cheapest.id) ?? []), { id, match: 'featured' }]);
      else if (product.variants.some((v) => v.id === id))
        hits.set(id, [...(hits.get(id) ?? []), { id, match: 'exact' }]);
    }
    const variants = product.variants.flatMap((v) => {
      const inputs = hits.get(v.id);
      return inputs ? [{ ...v, inputs }] : [];
    });
    if (variants.length) out.push({ ...product, variants });
  }
  return out;
}

type Selection = { name: string; id?: string; label: string };

/** Resolves a selection to an axis and value, by display name or code and by id or label. */
function resolve(
  variants: PublishedVariant[],
  ctx: UcpCatalogContext,
  s: Selection,
): { axis: string; code: string } | null {
  for (const v of variants)
    for (const [axis, o] of Object.entries(v.options))
      if (
        (axisName(ctx, axis) === s.name || axis === s.name) &&
        (s.id ? o.code === s.id : o.label === s.label)
      )
        return { axis, code: o.code };
  return null;
}

/**
 * `get_product`'s narrowing: per option, each value flagged against the other options' current
 * selections. `exists` says a variant (priced in the currency) has the value together with those
 * selections; `available` is the same until the catalog carries stock, which it never emits.
 * `preferences` are option names in priority order and come first; a selection that names no
 * option or value of this product is ignored.
 */
export function detailOptions(
  doc: ProductDoc,
  selected: Selection[],
  preferences: string[],
  ctx: UcpCatalogContext,
): { selected: UcpSelectedOption[]; options: { name: string; values: UcpDetailOptionValue[] }[] } {
  const kept = doc.variants.filter((v) => v.price?.currency === ctx.currency);
  const picks = new Map<string, string>();
  for (const s of selected) {
    const r = resolve(kept, ctx, s);
    if (r) picks.set(r.axis, r.code);
  }
  const options = axisOptions(kept, ctx).map((o) => {
    const axis = o.axis;
    return {
      axis,
      name: o.name,
      values: o.values.map((val) => {
        const exists = kept.some(
          (v) =>
            v.options[axis]?.code === val.id &&
            [...picks].every(([a, code]) => a === axis || v.options[a]?.code === code),
        );
        return { ...val, exists, available: exists };
      }),
    };
  });
  const rank = (name: string) => {
    const i = preferences.indexOf(name);
    return i < 0 ? preferences.length : i;
  };
  options.sort((a, b) => rank(a.name) - rank(b.name));
  return {
    selected: [...picks].flatMap(([axis, code]) => {
      const o = options.find((x) => x.axis === axis)?.values.find((x) => x.id === code);
      return o ? [{ name: axisName(ctx, axis), id: code, label: o.label }] : [];
    }),
    options: options.map(({ name, values }) => ({ name, values })),
  };
}

/** `get_product`'s product: the mapped product plus the narrowing state. */
export function toUcpDetailProduct(
  doc: ProductDoc,
  selected: Selection[],
  preferences: string[],
  ctx: UcpCatalogContext,
): UcpDetailProduct | null {
  const product = toUcpProduct(doc, ctx);
  if (!product) return null;
  const d = detailOptions(doc, selected, preferences, ctx);
  return { ...product, ...(d.selected.length ? { selected: d.selected } : {}), options: d.options };
}

// ── Requests ───────────────────────────────────────────────────────────────

export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 25;
export const LOOKUP_IDS_MAX = 50;
export const SELECTED_MAX = 5;

/** `common/types/context.json`, the fields a merchant's catalog can act on. */
const context = z
  .object({
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    language: z.string().max(35).optional(),
  })
  .loose();

const filters = z
  .object({
    categories: z.array(z.string().max(200)).max(20).optional(),
    price: z
      .object({
        min: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        max: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .optional(),
  })
  .loose();

/** `catalog_search.json#/$defs/search_request`. */
export const ucpSearchInput = z.object({
  query: z.string().max(QUERY_MAX).optional(),
  filters: filters.optional(),
  context: context.optional(),
  pagination: z
    .object({
      cursor: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).default(SEARCH_LIMIT_DEFAULT),
    })
    .default({ limit: SEARCH_LIMIT_DEFAULT }),
});
export type UcpSearchInput = z.infer<typeof ucpSearchInput>;

/** `catalog_lookup.json#/$defs/lookup_request`. */
export const ucpLookupInput = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(LOOKUP_IDS_MAX),
  filters: filters.optional(),
  context: context.optional(),
});
export type UcpLookupInput = z.infer<typeof ucpLookupInput>;

const selection = z.object({
  name: z.string().min(1).max(200),
  id: z.string().max(200).optional(),
  label: z.string().min(1).max(200),
});

/** `catalog_lookup.json#/$defs/get_product_request`. */
export const ucpGetProductInput = z.object({
  id: z.string().min(1).max(200),
  selected: z.array(selection).max(SELECTED_MAX).optional(),
  preferences: z.array(z.string().max(200)).max(SELECTED_MAX).optional(),
  filters: filters.optional(),
  context: context.optional(),
});
export type UcpGetProductInput = z.infer<typeof ucpGetProductInput>;

// ── Pagination ─────────────────────────────────────────────────────────────

/** A cursor is opaque to the platform: the offset of the next page, in base64url. */
export function encodeCursor(offset: number): string {
  return btoa(`o:${offset}`).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** The offset a cursor names, or null for one that isn't ours (an invalid cursor is a refusal). */
export function decodeCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return 0;
  try {
    const raw = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'));
    const m = /^o:(\d{1,9})$/.exec(raw);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * The page of `items` a request names, and the response's `pagination`. `has_next_page` is true
 * only with a cursor, as the schema requires. Pass `total` when the count is known.
 */
export function paginate<T>(
  items: T[],
  page: { cursor?: string; limit: number },
  total?: number,
): {
  items: T[];
  pagination: { has_next_page: boolean; cursor?: string; total_count?: number };
} | null {
  const offset = decodeCursor(page.cursor);
  if (offset === null) return null;
  const end = offset + page.limit;
  const hasNext = items.length > end;
  return {
    items: items.slice(offset, end),
    pagination: {
      has_next_page: hasNext,
      ...(hasNext ? { cursor: encodeCursor(end) } : {}),
      ...(total !== undefined ? { total_count: total } : {}),
    },
  };
}

/** The `ucp` envelope every catalog response carries. */
export const ucpCatalogEnvelope = () => ({ version: UCP_VERSION, status: 'success' as const });
