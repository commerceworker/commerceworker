/**
 * The promotions an order's codes give it (`commerce.discount`): each code is checked against its
 * promotion (`promotionProblem`), the usable ones are chosen (`choosePromotions`: one, or several
 * that stack), applied line by line (`applyPromotion`), and each redemption is held through the
 * pricing port before it counts, so a code used up meanwhile is refused rather than given twice.
 * Keyed by the step: a retried step holds the same redemptions. A dry run (a quote) holds none.
 */
import {
  type AppliedPromotion,
  applyPromotion,
  choosePromotions,
  computeTotals,
  type Order,
  type Promotion,
  promoCodesOf,
  promotionProblem,
  unknownPromotion,
} from '@commerceworker/core';
import type { PricingStore } from '@commerceworker/ports/commerce';

export type PromotionsApplied = {
  /** The order's lines and totals with the promotions taken off; undefined when it had no codes. */
  order?: Pick<Order, 'lines'> & ReturnType<typeof computeTotals>;
  applied: AppliedPromotion[];
  /** Each code left out and why, in the order the codes were given. */
  refused: { code: string; reason: string }[];
};

export async function applyPromotions(
  ports: { readonly pricing: PricingStore },
  order: Order,
  opts: { now: number; stack: boolean; stepKey: string; dryRun: boolean },
): Promise<PromotionsApplied> {
  const codes = promoCodesOf(order.meta);
  if (!codes.length) return { applied: [], refused: [] };
  const found = await ports.pricing.promotionsByCode(codes);
  // In the order the codes were given, so where a refusal sits says nothing about which exist.
  const refused: PromotionsApplied['refused'] = [];
  const usable: Promotion[] = [];
  for (const code of codes) {
    const p = found.find((f) => f.code === code);
    if (!p) {
      refused.push({ code, reason: unknownPromotion(code) });
      continue;
    }
    const redeemed = await ports.pricing.redemptionsOf(p.id, order.id, order.customerId);
    const why = promotionProblem(p, {
      now: opts.now,
      customerId: order.customerId,
      currency: order.currency,
      fxRate: order.fxRate,
      lines: order.lines,
      redeemed,
    });
    if (why) refused.push({ code: p.code, reason: why });
    else usable.push(p);
  }
  const chosen = choosePromotions(usable, order.lines, {
    fxRate: order.fxRate,
    shipping: order.shipping ?? 0,
    stack: opts.stack,
  });
  for (const p of usable)
    if (!chosen.includes(p))
      refused.push({ code: p.code, reason: `${p.code} isn't combined with another code.` });
  let lines = order.lines;
  let shipping = order.shipping;
  const applied: AppliedPromotion[] = [];
  for (const p of chosen) {
    const r = applyPromotion(p, lines, { fxRate: order.fxRate });
    const amount = p.kind === 'free_shipping' ? (shipping ?? 0) : r.amount;
    // The redemption is the order's once it holds it; a code used up meanwhile is refused.
    const held =
      opts.dryRun ||
      (await ports.pricing.redeem({
        promotion: p,
        orderId: order.id,
        customerId: order.customerId,
        amount,
        stepKey: opts.stepKey,
      }));
    if (!held) {
      refused.push({ code: p.code, reason: `${p.code} has been used up.` });
      continue;
    }
    lines = r.lines;
    if (p.kind === 'free_shipping') shipping = 0;
    applied.push({ id: p.id, code: p.code, name: p.name, kind: p.kind, amount });
  }
  return { order: { lines, ...computeTotals({ ...order, lines, shipping }) }, applied, refused };
}
