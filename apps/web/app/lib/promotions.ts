/**
 * How the Promotions page shows a promotion's state and reads its form; the `commerce.discount`
 * node decides what applies.
 */

import {
  type BxgyRule,
  bxgyShapeProblem,
  MAX_CONDITION_MESSAGE,
  normalizePromoCode,
  PROMOTION_KINDS,
  PROMOTION_STACKING,
  type PromotionKind,
  type PromotionStacking,
  parseBxgyRule,
  parsePromotionCondition,
} from '@commerceworker/core';

export type PromotionState = 'active' | 'paused' | 'ended';

/**
 * A code past its end date has ended, paused or not: resuming it would change nothing, so saying
 * "paused" would suggest otherwise. Judged as the node judges it (`now >= validTo`).
 */
export function promotionState(
  p: { status: string; validTo: number | null },
  now: number,
): PromotionState {
  if (p.validTo !== null && now >= p.validTo) return 'ended';
  return p.status === 'paused' ? 'paused' : 'active';
}

export type PromotionForm = {
  /** Null for an automatic promotion. */
  code: string | null;
  name: string;
  kind: PromotionKind;
  value: number;
  minSubtotal: number | null;
  skus: string[] | null;
  customerId: string | null;
  validTo: number | null;
  maxRedemptions: number | null;
  perCustomerLimit: number | null;
  priority: number;
  stacking: PromotionStacking;
  maxDiscount: number | null;
  condition: object | null;
  conditionMessage: string | null;
  /** Set for `bxgy`, and only then. */
  bxgy: BxgyRule | null;
};

/** The promotion a form describes, or why it can't be one. */
export function promotionFrom(f: FormData): PromotionForm | string {
  const s = (k: string) => String(f.get(k) ?? '').trim();
  // No code makes it automatic: it applies to any order it fits, and is known by its name.
  const code = s('code') ? normalizePromoCode(s('code')) : null;
  if (s('code') && !code) return 'A code is letters, digits, dashes and underscores, up to 32.';
  const name = s('name').slice(0, 120);
  if (!code && !name) return 'A promotion without a code needs a name.';
  const kind = s('kind') as PromotionKind;
  if (!PROMOTION_KINDS.includes(kind)) return 'Pick what the promotion does.';
  const value = kind === 'pct' || kind === 'amount' ? Number(s('value')) : 0;
  if (kind === 'pct' && !(value > 0 && value <= 100))
    return 'A percentage is above 0 and at most 100.';
  if (kind === 'amount' && !(value > 0)) return 'An amount off is above 0.';
  const optional = (k: string) => (s(k) ? Number(s(k)) : null);
  const whole = (n: number | null) => n === null || (Number.isInteger(n) && n > 0);
  const maxRedemptions = optional('maxRedemptions');
  const perCustomerLimit = optional('perCustomerLimit');
  if (!whole(maxRedemptions) || !whole(perCustomerLimit))
    return 'Limits are whole numbers above 0.';
  const minSubtotal = optional('minSubtotal');
  if (minSubtotal !== null && !(minSubtotal >= 0)) return 'A minimum subtotal is 0 or more.';
  const maxDiscount = optional('maxDiscount');
  if (maxDiscount !== null && !(maxDiscount > 0)) return 'A cap is above 0.';
  const priority = s('priority') ? Number(s('priority')) : 0;
  if (!Number.isInteger(priority) || Math.abs(priority) > 1000)
    return 'A priority is a whole number from -1000 to 1000.';
  const stacking = (s('stacking') || 'exclusive') as PromotionStacking;
  if (!PROMOTION_STACKING.includes(stacking)) return 'Pick how the promotion combines.';
  const validTo = s('validTo') ? Date.parse(`${s('validTo')}T23:59:59Z`) : null;
  if (validTo !== null && Number.isNaN(validTo)) return 'The end date is not a date.';
  // Pasted JSON Logic, checked here by the same rules the assistant's tool applies.
  let condition: object | null = null;
  if (s('condition')) {
    const parsed = parsePromotionCondition(s('condition'));
    if ('error' in parsed) return parsed.error;
    condition = parsed.condition;
  }
  const conditionMessage = s('conditionMessage').slice(0, MAX_CONDITION_MESSAGE) || null;
  if (conditionMessage && !condition) return 'A message for a failed condition needs a condition.';
  const list = (k: string) => {
    const skus = s(k)
      .split(/[\s,]+/)
      .filter(Boolean);
    return skus.length ? skus : null;
  };
  const skus = kind === 'bxgy' ? null : list('skus');
  // The rule's fields are only read for its own kind; a blank one takes the rule's default.
  let bxgy: BxgyRule | null = null;
  if (kind === 'bxgy') {
    const whole = (k: string) => (s(k) ? Number(s(k)) : undefined);
    const qtys = [whole('buyQty'), whole('getQty'), whole('repeat')];
    if (qtys.some((n) => n !== undefined && !Number.isInteger(n)))
      return 'Quantities and repeats are whole numbers.';
    if (!qtys[0] || !qtys[1] || qtys[0] < 1 || qtys[1] < 1)
      return 'Buy and get each need a quantity of at least 1.';
    const percent = s('getPercent') ? Number(s('getPercent')) : 100;
    const parsed = parseBxgyRule({
      buy: { skus: list('buySkus'), qty: qtys[0] },
      get: { skus: list('getSkus'), qty: qtys[1], percent },
      repeat: qtys[2] ?? null,
    });
    if ('error' in parsed) return parsed.error;
    bxgy = parsed.rule;
  }
  const shape = bxgyShapeProblem(kind, bxgy, skus);
  if (shape) return shape;
  return {
    code,
    name,
    kind,
    value,
    minSubtotal,
    skus,
    customerId: s('customerId') || null,
    validTo,
    maxRedemptions,
    perCustomerLimit,
    priority,
    stacking,
    maxDiscount,
    condition,
    conditionMessage,
    bxgy,
  };
}
