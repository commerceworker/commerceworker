/**
 * Pricing an order: the one pipeline the flow's price node and agentic checkout (which runs the
 * checkout flow's pricing nodes, `quoteNodes` in core) both reach. It reads products, the order's
 * exchange rate and the customer's price chain through the pricing port, resolves each line
 * (`resolvePrice` in core), and totals the order. Deterministic: time comes in as `now`.
 */
import {
  computeTotals,
  fromBase,
  isBuySide,
  type Order,
  type OrderLine,
  type PricedBy,
  resolvePrice,
} from '@commerceworker/core';
import type { PricingStore } from '@commerceworker/ports/commerce';

/** The order has no exchange rate for its currency, so it can't be priced (not a retryable fault). */
export class MissingExchangeRateError extends Error {
  constructor(readonly currency: string) {
    super(`No exchange rate for ${currency}`);
    this.name = 'MissingExchangeRateError';
  }
}

export interface PriceOrderOptions {
  /** `cost` prices at cost; `chain` runs the price chain; `auto` picks by the order's model. */
  readonly basis: 'auto' | 'cost' | 'chain' | (string & {});
  /** Whether contract prices and quotes count. */
  readonly useContracts: boolean;
  /** Whether price-book and volume rules count. */
  readonly usePriceRules: boolean;
  /** Milliseconds: rules with a start or end date, and price books, are checked against it. */
  readonly now: number;
}

export interface PricedLine {
  readonly sku: string;
  readonly unitPrice: number;
  readonly by: PricedBy['source'];
  /** What priced it: the price book's name for a book, else the rule's name. */
  readonly rule: string;
  /** The price book that priced it, when one did. */
  readonly bookId: string | null;
}

export interface PricedOrder {
  readonly lines: OrderLine[];
  readonly fxRate: number;
  readonly totals: ReturnType<typeof computeTotals>;
  /** How each line the pipeline priced got its price (lines given a price on the order included). */
  readonly priced: PricedLine[];
}

export async function priceOrder(
  ports: { readonly pricing: PricingStore },
  order: Pick<Order, 'lines' | 'currency' | 'customerId' | 'model'> &
    Partial<Pick<Order, 'shipping' | 'taxRate' | 'taxShipping'>>,
  options: PriceOrderOptions,
): Promise<PricedOrder> {
  // Buy-side models price at cost and sell-side models run the chain, unless the node says otherwise.
  const buying = options.basis === 'cost' || (options.basis === 'auto' && isBuySide(order.model));
  // Everything pricing reads, together: one round trip on D1. Base-currency prices convert at the
  // order's rate, fixed here for the life of the order.
  const {
    products: rows,
    fxRate: fx,
    chain,
  } = await ports.pricing.priceInputs(
    order.lines.map((l) => l.sku),
    order.currency,
    order.customerId,
    !buying,
    options.now,
  );
  if (fx === null) throw new MissingExchangeRateError(order.currency);
  const products = new Map(rows.map((p) => [p.sku, p]));
  const sources =
    chain?.sources.filter((s) =>
      // A quote is a negotiated price for the customer, as a contract price is.
      s.id === 'contract' || s.id === 'quote' ? options.useContracts : options.usePriceRules,
    ) ?? [];
  const priced: PricedLine[] = [];
  const lines = order.lines.map((l): OrderLine => {
    const p = products.get(l.sku);
    if (l.unitPrice !== undefined) {
      priced.push({
        sku: l.sku,
        unitPrice: l.unitPrice,
        by: 'list',
        rule: 'Given on the order',
        bookId: null,
      });
      return l;
    }
    if (!chain) return { ...l, unitPrice: fromBase(p?.cost ?? 0, fx) };
    const r = resolvePrice(l, p?.price ?? 0, sources, chain.rules, {
      customerId: order.customerId,
      customerTier: chain.tier,
      now: options.now,
    });
    const unitPrice = fromBase(r.unitPrice, fx);
    priced.push({
      sku: l.sku,
      unitPrice,
      by: r.by.source,
      rule: r.by.name,
      bookId: 'bookId' in r.by ? (r.by.bookId ?? null) : null,
    });
    return { ...l, unitPrice };
  });
  return { lines, fxRate: fx, totals: computeTotals({ ...order, lines, fxRate: fx }), priced };
}
