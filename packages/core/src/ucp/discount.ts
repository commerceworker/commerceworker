/**
 * The discount extension (`dev.ucp.shopping.discount`) as a view of the checkout quote: the codes
 * a platform sends are CommerceWorker's promotion codes, and `discounts.applied` is what the flow's
 * discount step (`commerce.discount`) applied when the session was priced, never a second
 * calculation. Pure; the totals and line items in ./checkout.ts are built from the same numbers,
 * so they and `applied` always agree.
 *
 * Promotions lower the lines' unit prices (../promotions.ts), so the quote's subtotal is already
 * discounted. The view adds the discount back to show a list-price subtotal, with the discount as
 * its own negative total, and the total does not move.
 */

import { MAX_PROMO_CODES, normalizePromoCode } from '../cart';
import type { CheckoutIssue, CheckoutSession } from '../checkout';
import { toMinor } from '../money';
import { unknownPromotion } from '../promotions';

/** Codes a request may carry, the most a cart holds. */
export const MAX_DISCOUNT_CODES = MAX_PROMO_CODES;

/** The path an allocation to the shipping charge names (RFC 9535). */
const SHIPPING_TOTAL_PATH = '$.totals[?@.type == "fulfillment"]';

/** `$defs/applied_discount` of `shopping/discount.json`. */
export type AppliedDiscount = {
  code: string;
  title: string;
  amount: number;
  method?: 'each' | 'across';
  allocations?: { path: string; amount: number }[];
};

export type DiscountView = {
  /** The codes as the platform sent them. */
  codes: string[];
  applied: AppliedDiscount[];
  /** What the promotions took off the lines, and off shipping, in minor units. */
  items: number;
  shipping: number;
  /** What came off each priced line (by its index in the quote), in minor units; sums to `items`. */
  lines: number[];
  /** A `promotion` warning for each code left out, at its place in `discounts.codes`. */
  messages: CheckoutIssue[];
};

/**
 * `s`'s codes and what the quote applied for them. A code is refused with the reason the
 * discount step gave (or, for one that can't be a code at all, as unknown); it stays in `codes`
 * as sent.
 *
 * Allocations are given only where they can be derived from the step's own result: the lines'
 * prices before and after it for a single line discount, the shipping total for free shipping. With
 * several line discounts the step gives one result for all of them, so none is attributed to a line.
 * A line's share is the discount split by each line's price difference, in whole minor units by
 * largest remainder: no share is negative and they sum to the discount's amount exactly.
 *
 * A code that did nothing is not "applied": free shipping with nothing to take off (the flow rates
 * shipping after its promotions step) is left out with a warning, and with no discount step in the
 * flow every code is told it doesn't apply.
 */
export function discountView(s: CheckoutSession): DiscountView {
  const q = s.quote;
  const m = (n: number) => toMinor(n, s.currency);
  const codes = s.promoCodes ?? [];
  const quoted = q?.discounts?.applied ?? [];
  const idle = quoted.filter((a) => a.kind === 'free_shipping' && m(a.amount) === 0);
  const applied = quoted.filter((a) => !idle.includes(a));
  const lineKinds = applied.filter((a) => a.kind !== 'free_shipping');
  const items = lineKinds.reduce((n, a) => n + m(a.amount), 0);
  const shipping = applied
    .filter((a) => a.kind === 'free_shipping')
    .reduce((n, a) => n + m(a.amount), 0);

  const weight = (q?.lines ?? []).map((l) =>
    Math.max(0, ((l.listPrice ?? l.unitPrice) - l.unitPrice) * l.qty),
  );
  const lines = largestRemainder(items, weight);
  const spread = lines.flatMap((amount, i) =>
    amount > 0 ? [{ path: `$.line_items[${i}]`, amount }] : [],
  );

  const out: AppliedDiscount[] = applied.map((a) => {
    const amount = m(a.amount);
    const base = { code: a.code, title: a.title, amount };
    if (a.kind === 'free_shipping')
      return {
        ...base,
        ...(amount > 0 ? { allocations: [{ path: SHIPPING_TOTAL_PATH, amount }] } : {}),
      };
    return {
      ...base,
      method: a.kind === 'pct' ? 'each' : 'across',
      ...(lineKinds.length === 1 && spread.length ? { allocations: spread } : {}),
    };
  });

  const refused = new Map((q?.discounts?.refused ?? []).map((r) => [r.code, r.reason]));
  for (const a of idle)
    refused.set(
      a.code,
      `${a.code} takes nothing off: this checkout's shipping is rated after its promotions.`,
    );
  const messages: CheckoutIssue[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of codes.entries()) {
    const code = normalizePromoCode(raw);
    if (code && seen.has(code)) continue;
    if (code) seen.add(code);
    // Without a quote nothing was tried, so nothing is refused yet.
    const reason = !q
      ? undefined
      : !q.discounts
        ? "Discount codes don't apply to this checkout."
        : code
          ? refused.get(code)
          : unknownPromotion(raw.trim());
    if (reason)
      messages.push({
        kind: 'warning',
        code: 'promotion',
        content: reason,
        path: `$.discounts.codes[${i}]`,
      });
  }
  return { codes, applied: out, items, shipping, lines, messages };
}

/** `total` split in proportion to `weights` as whole numbers that sum to it, none below zero. */
function largestRemainder(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || total <= 0) return weights.map(() => 0);
  const quota = weights.map((w) => (total * w) / sum);
  const shares = quota.map((q) => Math.floor(q + 1e-9));
  let left = total - shares.reduce((a, b) => a + b, 0);
  const byRemainder = quota
    .map((q, i) => ({ i, r: q - shares[i]! }))
    .filter((x) => weights[x.i]! > 0)
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    shares[i]! += 1;
    left -= 1;
  }
  return shares;
}
