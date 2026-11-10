/**
 * The promotions an order gets (`commerce.discount`): the codes it carries and the automatic
 * promotions (those with no code) are the candidates. Each is checked against the order
 * (`promotionProblem`), the usable ones are chosen by their own priority and stacking
 * (`choosePromotions`), applied line by line with their caps (`applyPromotion`), and each
 * redemption is held through the pricing port before it counts, so a promotion used up meanwhile
 * is refused rather than given twice. Keyed by the step: a retried step holds the same
 * redemptions. A dry run (a quote) holds none.
 *
 * Only a code the order carries is ever refused with a reason (a promotion's `conditionMessage`,
 * when its condition fails and it has one); an automatic promotion that doesn't fit, or loses to
 * another, is simply not applied.
 */
import {
  type AppliedPromotion,
  applyPromotion,
  choosePromotions,
  computeTotals,
  type Order,
  type Promotion,
  promoCodesOf,
  promotionLabel,
  promotionProblem,
  unknownPromotion,
} from '@commerceworker/core';
import type { PricingStore } from '@commerceworker/ports/commerce';

export type PromotionsApplied = {
  /** The order's lines and totals with the promotions taken off; undefined when nothing was tried. */
  order?: Pick<Order, 'lines'> & ReturnType<typeof computeTotals>;
  applied: AppliedPromotion[];
  /** Each code left out and why, in the order the codes were given. */
  refused: { code: string; reason: string }[];
};

export async function applyPromotions(
  ports: { readonly pricing: PricingStore },
  order: Order,
  opts: { now: number; stepKey: string; dryRun: boolean },
): Promise<PromotionsApplied> {
  const codes = promoCodesOf(order.meta);
  const [found, automatic] = await Promise.all([
    codes.length ? ports.pricing.promotionsByCode(codes) : [],
    ports.pricing.automaticPromotions(opts.now),
  ]);
  if (!codes.length && !automatic.length) return { applied: [], refused: [] };
  // In the order the codes were given, so where a refusal sits says nothing about which exist.
  const refused = new Map<string, string>();
  const usable: Promotion[] = [];
  // Read once, and only when a candidate has a condition that may ask about the buyer.
  let customer: Promise<{ kind: string; tier: string } | undefined> | undefined;
  const customerOf = () =>
    (customer ??= ports.pricing
      .customer(order.customerId)
      .then((c) => c && { kind: c.kind, tier: c.tier }));
  const check = async (p: Promotion) => {
    // Only a promotion with a limit needs its redemptions counted.
    const redeemed =
      p.maxRedemptions !== null || p.perCustomerLimit !== null
        ? await ports.pricing.redemptionsOf(p.id, order.id, order.customerId)
        : { total: 0, byCustomer: 0 };
    return promotionProblem(p, {
      now: opts.now,
      customerId: order.customerId,
      currency: order.currency,
      fxRate: order.fxRate,
      channel: order.channel,
      lines: order.lines,
      meta: order.meta,
      customer: p.condition && order.customerId ? await customerOf() : undefined,
      redeemed,
    });
  };
  for (const code of codes) {
    const p = found.find((f) => f.code === code);
    if (!p) {
      refused.set(code, unknownPromotion(code));
      continue;
    }
    const why = await check(p);
    if (why) refused.set(code, why);
    else usable.push(p);
  }
  for (const p of automatic) if (!(await check(p))) usable.push(p);

  const { chosen, left } = choosePromotions(usable, order, { fxRate: order.fxRate });
  for (const { promotion, reason } of left) if (promotion.code) refused.set(promotion.code, reason);

  let lines = order.lines;
  let shipping = order.shipping;
  const applied: AppliedPromotion[] = [];
  for (const p of chosen) {
    const r = applyPromotion(p, { lines, shipping }, { fxRate: order.fxRate });
    // The redemption is the order's once it holds it; a promotion used up meanwhile is refused.
    const held =
      opts.dryRun ||
      (await ports.pricing.redeem({
        promotion: p,
        orderId: order.id,
        customerId: order.customerId,
        amount: r.amount,
        stepKey: opts.stepKey,
      }));
    if (!held) {
      if (p.code) refused.set(p.code, `${promotionLabel(p)} has been used up.`);
      continue;
    }
    lines = r.lines;
    shipping = r.shipping ?? shipping;
    applied.push({ id: p.id, code: p.code, name: p.name, kind: p.kind, amount: r.amount });
  }
  return {
    order: { lines, ...computeTotals({ ...order, lines, shipping }) },
    applied,
    refused: codes.flatMap((code) => {
      const reason = refused.get(code);
      return reason ? [{ code, reason }] : [];
    }),
  };
}
