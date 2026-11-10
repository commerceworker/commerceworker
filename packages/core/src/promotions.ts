/**
 * Promotions: codes a buyer or staff enter (a cart's codes reach the order as `meta.promoCodes`)
 * and automatic promotions that have none, applied by the `commerce.discount` node. Pure: the
 * engine reads the `promotions` table and counts redemptions; this decides which promotions apply
 * and what they take off.
 *
 * Every stored field is interpreted here and nowhere else: `promotionProblem` is the one gate on
 * whether a promotion fits an order (its typed fields, then its JSON Logic `condition`, see
 * `promotion-conditions.ts`), `applyPromotion` the one place a kind turns into a discount,
 * and `choosePromotions` the one place stacking and priority are decided.
 *
 * A discount lowers the unit prices of the lines it covers, so the subtotal, tax, invoices and
 * refunds that follow all work from prices already discounted, and nothing else needs to know a
 * discount exists. `free_shipping` takes the order's shipping charge to zero instead.
 */

import { normalizePromoCode } from './cart';
import { fromBase, money, toBase } from './logic';
import { type BxgyRule, bxgyGroups, bxgyNeeds, bxgyOffs } from './promotion-bxgy';
import { type ConditionInput, promotionConditionHolds } from './promotion-conditions';
import type { OrderLine } from './types';

export const PROMOTION_KINDS = ['pct', 'amount', 'free_shipping', 'bxgy'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

/**
 * `exclusive` is never combined with another promotion. `stackable` combines with other stackable
 * ones, each taking its discount off the prices the one before left.
 */
export const PROMOTION_STACKING = ['exclusive', 'stackable'] as const;
export type PromotionStacking = (typeof PROMOTION_STACKING)[number];

export type Promotion = {
  id: string;
  /** What a buyer enters; null for an automatic promotion, which applies to any order it fits. */
  code: string | null;
  name: string;
  kind: PromotionKind;
  /**
   * A percentage for `pct`; for `amount`, money in `currency` (or the base currency when null);
   * 0 for the kinds that take none (`free_shipping`, and `bxgy`, whose rule holds its own).
   */
  value: number;
  currency: string | null;
  /** In the base currency, compared with the order's subtotal converted. */
  minSubtotal: number | null;
  /** SKUs it covers; null for every line. A `bxgy` promotion names its SKUs in its rule instead. */
  skus: string[] | null;
  customerId: string | null;
  validFrom: number | null;
  validTo: number | null;
  maxRedemptions: number | null;
  perCustomerLimit: number | null;
  status: 'active' | 'paused';
  /** Higher is considered first: it is applied first when promotions stack, and wins a tie. */
  priority: number;
  stacking: PromotionStacking;
  /** The most it takes off one order, in the base currency; null for no cap. */
  maxDiscount: number | null;
  /** What `bxgy` buys and gets (see `promotion-bxgy.ts`); null for every other kind. */
  bxgy: BxgyRule | null;
  /**
   * A JSON Logic expression the order must meet, beside the fields above (see
   * `promotion-conditions.ts`); null for none.
   */
  condition: object | null;
  /** What a buyer entering the code is told when `condition` fails; null for the default. */
  conditionMessage: string | null;
};

/** What a promotion is called to people: its code, else its name. */
export const promotionLabel = (p: Pick<Promotion, 'code' | 'name' | 'id'>) =>
  p.code ?? (p.name || p.id);

/** The codes an order carries, normalised and once each. */
export function promoCodesOf(meta: Record<string, unknown> | undefined): string[] {
  const raw = meta?.promoCodes;
  if (!Array.isArray(raw)) return [];
  const codes = raw
    .filter((c): c is string => typeof c === 'string')
    .map(normalizePromoCode)
    .filter((c): c is string => !!c);
  return [...new Set(codes)].slice(0, 10);
}

export type PromotionContext = ConditionInput & {
  /** Redemptions so far, for the limits: all of them, and this customer's. */
  redeemed: { total: number; byCustomer: number };
};

const eligible = (p: Pick<Promotion, 'skus'>, lines: OrderLine[]) =>
  lines.filter((l) => !p.skus || p.skus.includes(l.sku));

const subtotalOf = (lines: OrderLine[]) =>
  money(lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0));

/** What a code that matches no promotion (or one reserved for another customer) is told. */
export const unknownPromotion = (code: string) => `${code} isn't a promotion.`;

/** Why `p` doesn't apply to this order, or null when it does. */
export function promotionProblem(p: Promotion, c: PromotionContext): string | null {
  const l = promotionLabel(p);
  // Before anything else, and in the same words as a code that doesn't exist, so a buyer can't
  // learn that another customer's code exists (nor that it's paused, upcoming or expired).
  if (p.customerId && p.customerId !== c.customerId) return unknownPromotion(l);
  if (p.status !== 'active') return `${l} is paused.`;
  if (p.validFrom !== null && c.now < p.validFrom) return `${l} isn't valid yet.`;
  if (p.validTo !== null && c.now >= p.validTo) return `${l} has expired.`;
  if (p.currency && p.currency !== c.currency) return `${l} is for ${p.currency} orders.`;
  if (p.maxRedemptions !== null && c.redeemed.total >= p.maxRedemptions)
    return `${l} has been used up.`;
  if (p.perCustomerLimit !== null && c.customerId && c.redeemed.byCustomer >= p.perCustomerLimit)
    return `${l} has already been used by this customer.`;
  if (p.kind === 'bxgy') {
    // A bxgy promotion with no readable rule (never written by a surface) takes nothing off.
    if (!p.bxgy) return `${l} has no buy X, get Y rule.`;
    if (!bxgyGroups(p.bxgy, c.lines)) return `${l} needs ${bxgyNeeds(p.bxgy)} in the order.`;
  } else if (!eligible(p, c.lines).length) return `${l} doesn't cover anything in the order.`;
  if (p.minSubtotal !== null && toBase(subtotalOf(c.lines), c.fxRate) < p.minSubtotal)
    return `${l} needs a subtotal of at least ${p.minSubtotal}.`;
  // Last: the typed fields are cheap and their refusals say more.
  if (p.condition !== null && !promotionConditionHolds(p.condition, c))
    return p.conditionMessage || `This order doesn't qualify for ${l}.`;
  return null;
}

export type AppliedPromotion = {
  id: string;
  /** The code that gave it; null for an automatic promotion. */
  code: string | null;
  name: string;
  kind: PromotionKind;
  /** What it took off (for free shipping, off the shipping charge), in the order's currency. */
  amount: number;
};

/** Unit prices keep four decimals; the subtotal is rounded to cents as always. */
const unit = (n: number) => Math.round(n * 10_000) / 10_000;

type Priced = { lines: OrderLine[]; shipping?: number };

/**
 * `order` with `p` applied, and what it took off. Assumes `promotionProblem` found nothing. The
 * promotion's cap (`maxDiscount`, in the base currency) limits what it takes off, after its own
 * arithmetic: a line discount is scaled down across the lines it covers, free shipping takes off
 * at most the cap. A `bxgy` promotion takes the cheapest units its rule discounts off the lines
 * that hold them (`bxgyOffs`).
 */
export function applyPromotion(
  p: Promotion,
  order: Priced,
  c: Pick<PromotionContext, 'fxRate'>,
): { lines: OrderLine[]; shipping: number | undefined; amount: number } {
  const cap = p.maxDiscount === null ? Number.POSITIVE_INFINITY : fromBase(p.maxDiscount, c.fxRate);
  if (p.kind === 'free_shipping') {
    const off = Math.min(order.shipping ?? 0, cap);
    return {
      lines: order.lines,
      shipping: order.shipping && money(order.shipping - off),
      amount: money(off),
    };
  }
  const { lines } = order;
  if (p.kind === 'bxgy') {
    const offs = p.bxgy ? bxgyOffs(p.bxgy, lines, cap) : [];
    // The line carries its discount as a lower unit price: the average over its units, to four
    // decimals, so the line's total is what it was less exactly what its units gave up.
    const next = lines.map((l, i) =>
      offs[i] && l.unitPrice !== undefined
        ? { ...l, unitPrice: unit((l.qty * l.unitPrice - offs[i]) / l.qty) }
        : l,
    );
    return {
      lines: next,
      shipping: order.shipping,
      amount: money(subtotalOf(lines) - subtotalOf(next)),
    };
  }
  const covered = new Set(eligible(p, lines));
  const base = subtotalOf([...covered]);
  if (base <= 0) return { lines, shipping: order.shipping, amount: 0 };
  const wanted =
    p.kind === 'pct'
      ? money(base * (Math.min(Math.max(p.value, 0), 100) / 100))
      : Math.min(base, p.currency ? money(p.value) : fromBase(p.value, c.fxRate));
  const share = Math.min(wanted, cap) / base;
  const next = lines.map((l) =>
    covered.has(l) && l.unitPrice !== undefined
      ? { ...l, unitPrice: unit(l.unitPrice * (1 - share)) }
      : l,
  );
  return {
    lines: next,
    shipping: order.shipping,
    amount: money(subtotalOf(lines) - subtotalOf(next)),
  };
}

export type PromotionChoice = {
  /** The promotions to apply, in order: each on the prices the one before left. */
  chosen: Promotion[];
  /** The usable promotions left out, each with the ones it isn't combined with. */
  left: { promotion: Promotion; reason: string }[];
};

/** Applies `plan` in order, caps included, and totals what it takes off. */
function worthOf(plan: Promotion[], order: Priced, c: Pick<PromotionContext, 'fxRate'>): number {
  let cur = order;
  let total = 0;
  for (const p of plan) {
    const r = applyPromotion(p, cur, c);
    cur = { lines: r.lines, shipping: r.shipping };
    total += r.amount;
  }
  return money(total);
}

/**
 * Which of the usable promotions (`promotionProblem` found nothing against them) to apply.
 *
 * They are ranked by priority, higher first, then by what each would take off alone, larger
 * first. Stackable promotions combine into one set, applied in that order. An exclusive promotion
 * is never combined, so it is a set of one. The set that takes the most off the order wins; a tie
 * goes to the stackable set, then to the higher-ranked exclusive promotion. So an exclusive promotion
 * displaces the stackable ones only when it alone beats them together, caps included, and any
 * promotion left out says which it wasn't combined with.
 */
export function choosePromotions(
  usable: Promotion[],
  order: Priced,
  c: Pick<PromotionContext, 'fxRate'>,
): PromotionChoice {
  const alone = new Map(usable.map((p) => [p, applyPromotion(p, order, c).amount]));
  const ranked = [...usable].sort(
    (a, b) => b.priority - a.priority || alone.get(b)! - alone.get(a)! || a.id.localeCompare(b.id),
  );
  const stackable = ranked.filter((p) => p.stacking === 'stackable');
  const plans = [
    ...(stackable.length ? [stackable] : []),
    ...ranked.filter((p) => p.stacking !== 'stackable').map((p) => [p]),
  ];
  let best: Promotion[] = [];
  let bestWorth = Number.NEGATIVE_INFINITY;
  for (const plan of plans) {
    const w = worthOf(plan, order, c);
    if (w > bestWorth) {
      best = plan;
      bestWorth = w;
    }
  }
  const names = best.map(promotionLabel).join(', ');
  const left = ranked
    .filter((p) => !best.includes(p))
    .map((p) => ({ promotion: p, reason: `${promotionLabel(p)} isn't combined with ${names}.` }));
  return { chosen: best, left };
}
