/**
 * Returns and claims, as a person records them. Pure: the order page checks a request with it as
 * it is filled in, and the engine checks it again before anything reaches the order. What it
 * builds is the `return.requested` payload, so a flow reads the same fields however the request
 * arrived.
 */

import { skuTaxRate } from './shipping';
import type { OrderLine } from './types';
import { boundText } from './untrusted';

/**
 * Why goods are coming back, or why they aren't. A return is the buyer's choice; a claim says the
 * seller or carrier got it wrong. `goodsBack: false` is a claim with nothing to send back, so a
 * flow skips the label and the restock.
 */
export const RETURN_REASONS = {
  changed_mind: { kind: 'return', label: 'Changed their mind', goodsBack: true },
  wrong_fit: { kind: 'return', label: 'Wrong size or fit', goodsBack: true },
  not_as_described: { kind: 'return', label: 'Not as described', goodsBack: true },
  damaged: { kind: 'claim', label: 'Arrived damaged', goodsBack: true },
  faulty: { kind: 'claim', label: 'Faulty', goodsBack: true },
  wrong_item: { kind: 'claim', label: 'Wrong item sent', goodsBack: true },
  short_shipped: { kind: 'claim', label: 'Missing from the delivery', goodsBack: false },
  lost_in_transit: { kind: 'claim', label: 'Lost in transit', goodsBack: false },
} as const;

export type ReturnReason = keyof typeof RETURN_REASONS;
export const RETURN_REASON_CODES = Object.keys(RETURN_REASONS) as ReturnReason[];
export const RETURN_NOTE_MAX = 300;

export type ReturnInput = {
  reasonCode: ReturnReason;
  lines: { sku: string; qty: number }[];
  /** What to refund, when not the lines' own value. */
  amount?: number;
  note?: string;
};

/** The `return.requested` payload a flow reads as `vars.return_requested`. */
export type ReturnRequest = {
  kind: 'return' | 'claim';
  reasonCode: ReturnReason;
  reason: string;
  goodsBack: boolean;
  lines: { sku: string; qty: number }[];
  /** What to refund: the lines' value with the tax charged on them, or the amount a person set. */
  amount: number;
  /** The tax within `amount`, when it is the lines' own value and they were taxed. */
  tax?: number;
  note?: string;
};

/** The rates an order was taxed at: `taxRate`, and `taxRates` for the SKUs taxed apart from it. */
type TaxedBy = { taxRate?: number; taxRates?: Record<string, number> };

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * What was paid for the lines, or null when one of them has no price: their value and the tax
 * charged on it, each SKU at its own rate (its tax class's) or else the order's. Shipping and the
 * tax on it aren't the goods', so they aren't in it.
 */
export function returnValue(
  lines: { sku: string; qty: number }[],
  ordered: OrderLine[],
  taxed: TaxedBy = {},
): number | null {
  const parts = returnParts(lines, ordered, taxed);
  return parts && cents(parts.value + parts.tax);
}

function returnParts(
  lines: { sku: string; qty: number }[],
  ordered: OrderLine[],
  taxed: TaxedBy,
): { value: number; tax: number } | null {
  let value = 0;
  let tax = 0;
  for (const { sku, qty } of lines) {
    let left = qty;
    // A SKU can be on the order twice at different prices: take them in order.
    for (const o of ordered.filter((l) => l.sku === sku)) {
      const take = Math.min(left, o.qty);
      if (take <= 0) break;
      if (o.unitPrice === undefined) return null;
      value += take * o.unitPrice;
      tax += take * o.unitPrice * skuTaxRate(taxed, sku);
      left -= take;
    }
  }
  return { value, tax };
}

/**
 * Checks a request against the order. The amount must be at least a cent once rounded: a request
 * that refunds nothing has no reason to reach the flow.
 */
export function returnRequest(
  input: ReturnInput,
  order: { lines: OrderLine[]; total?: number } & TaxedBy,
): { request: ReturnRequest } | { issue: string } {
  const reason = RETURN_REASONS[input.reasonCode];
  if (!reason) return { issue: 'Choose a reason.' };

  const limit = new Map<string, number>();
  for (const l of order.lines) limit.set(l.sku, (limit.get(l.sku) ?? 0) + l.qty);
  const want = new Map<string, number>();
  for (const { sku, qty } of input.lines) {
    if (!limit.has(sku)) return { issue: `${sku} isn't on this order.` };
    if (!(qty > 0)) return { issue: `Enter a quantity above zero for ${sku}.` };
    want.set(sku, (want.get(sku) ?? 0) + qty);
  }
  if (!want.size) return { issue: 'Choose at least one item.' };
  for (const [sku, qty] of want)
    if (qty > limit.get(sku)!) return { issue: `Only ${limit.get(sku)} of ${sku} were ordered.` };

  const lines = [...want].map(([sku, qty]) => ({ sku, qty }));
  const parts = input.amount === undefined ? returnParts(lines, order.lines, order) : null;
  const value = input.amount ?? (parts && parts.value + parts.tax);
  if (value === null) return { issue: 'These items have no price: enter the amount to refund.' };
  // Rounded first: what is checked is what the card shows and the refund reads.
  const amount = cents(value);
  const tax = parts ? cents(parts.tax) : 0;
  if (!(amount > 0)) return { issue: 'Enter an amount above zero to refund.' };
  if (order.total !== undefined && amount > order.total)
    return { issue: 'That is more than the order total.' };

  const note = boundText(input.note, RETURN_NOTE_MAX);
  return {
    request: {
      kind: reason.kind,
      reasonCode: input.reasonCode,
      reason: reason.label,
      goodsBack: reason.goodsBack,
      lines,
      amount,
      ...(tax > 0 ? { tax } : {}),
      ...(note ? { note } : {}),
    },
  };
}

/**
 * Whether a flow branches on `goodsBack`. One that doesn't sends every request down the label path
 * and waits for goods that are never coming, then ends with no refund, so a claim with nothing to
 * send back is refused on it.
 */
export const flowReadsGoodsBack = (flow: { nodes: unknown[] } | null | undefined) =>
  !!flow && JSON.stringify(flow.nodes).includes('return_requested.goodsBack');
