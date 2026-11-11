/**
 * The pricing chain for `commerce.price`. Pure: the engine loads the sources and their entries from
 * D1 and passes them in with the list price.
 *
 * Sources run in `priority` order (lowest first): the `quote` source (an accepted, unexpired quote
 * of the customer's company) comes first and stops the chain, so a negotiated price is the price.
 * Within a source, the lowest price among its matching entries counts, so the deepest volume tier
 * wins. The price-book source ranks first by the entry's book: the highest-priority book that prices the line wins, then the lowest price in
 * it (an entry in no book ranks below every book). Equal ranks break by book id, then entry id,
 * so the same inputs always price the same way. Each source that matches adds that price as a
 * candidate, and a matching source with `stopProcessing` ends the chain. The line takes the lowest
 * candidate; with none, the list price.
 */

export const PRICE_SOURCES = ['quote', 'price_book', 'contract', 'volume'] as const;
export type PriceSourceKind = (typeof PRICE_SOURCES)[number];

export type PriceSource = {
  id: PriceSourceKind;
  label: string;
  priority: number;
  stopProcessing: boolean;
};

/** One entry in a source. Empty scope fields match anything. */
export type PriceRule = {
  id: string;
  source: PriceSourceKind;
  name: string;
  sku?: string | null;
  customerId?: string | null;
  customerTier?: string | null;
  /** The line's quantity must be at least this. */
  minQty?: number | null;
  /** The line's quantity must be at most this (a quote's line: the quantity it was agreed for). */
  maxQty?: number | null;
  /** A fixed unit price, or else `discountPct` off the list price. */
  price?: number | null;
  discountPct?: number | null;
  startsAt?: number | null;
  endsAt?: number | null;
  /** The price book the entry belongs to; null for an entry in none. */
  bookId?: string | null;
  /** That book's priority: the higher wins within the price-book source. */
  bookPriority?: number | null;
};

export type PriceContext = {
  customerId?: string | null;
  customerTier?: string | null;
  now: number;
};

export type PricedBy =
  | { source: PriceSourceKind; ruleId: string; name: string; bookId?: string | null }
  | { source: 'list'; ruleId: null; name: 'List price' };

export type ResolvedPrice = { unitPrice: number; by: PricedBy };

const LIST: PricedBy = { source: 'list', ruleId: null, name: 'List price' };

const round = (n: number) => Math.round(n * 100) / 100;

export function matchesRule(
  r: PriceRule,
  line: { sku: string; qty: number },
  ctx: PriceContext,
): boolean {
  if (r.sku && r.sku !== line.sku) return false;
  if (r.customerId && r.customerId !== ctx.customerId) return false;
  if (r.customerTier && r.customerTier !== ctx.customerTier) return false;
  if (r.minQty && line.qty < r.minQty) return false;
  if (r.maxQty && line.qty > r.maxQty) return false;
  if (r.startsAt && ctx.now < r.startsAt) return false;
  if (r.endsAt && ctx.now >= r.endsAt) return false;
  return r.price != null || r.discountPct != null;
}

function priceOf(r: PriceRule, listPrice: number) {
  if (r.price != null) return round(r.price);
  return round(listPrice * (1 - (r.discountPct ?? 0) / 100));
}

/** Whether `a` ranks above `b` within a source: book priority, then price, then ids. */
function outranks(
  a: { rule: PriceRule; unitPrice: number },
  b: { rule: PriceRule; unitPrice: number },
): boolean {
  const pa = a.rule.bookPriority ?? Number.NEGATIVE_INFINITY;
  const pb = b.rule.bookPriority ?? Number.NEGATIVE_INFINITY;
  if (pa !== pb) return pa > pb;
  if (a.unitPrice !== b.unitPrice) return a.unitPrice < b.unitPrice;
  const books = (a.rule.bookId ?? '').localeCompare(b.rule.bookId ?? '');
  return books !== 0 ? books < 0 : a.rule.id.localeCompare(b.rule.id) < 0;
}

export function resolvePrice(
  line: { sku: string; qty: number },
  listPrice: number,
  sources: PriceSource[],
  rules: PriceRule[],
  ctx: PriceContext,
): ResolvedPrice {
  let best: ResolvedPrice | null = null;
  const ordered = [...sources].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const source of ordered) {
    let top: { rule: PriceRule; unitPrice: number } | null = null;
    for (const r of rules) {
      if (r.source !== source.id || !matchesRule(r, line, ctx)) continue;
      const c = { rule: r, unitPrice: priceOf(r, listPrice) };
      if (!top || outranks(c, top)) top = c;
    }
    if (!top) continue;
    const mine: ResolvedPrice = {
      unitPrice: top.unitPrice,
      by: {
        source: source.id,
        ruleId: top.rule.id,
        name: top.rule.name,
        ...(top.rule.bookId ? { bookId: top.rule.bookId } : {}),
      },
    };
    if (!best || mine.unitPrice < best.unitPrice) best = mine;
    if (source.stopProcessing) break;
  }
  return best ?? { unitPrice: listPrice, by: LIST };
}
