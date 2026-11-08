/** Promotion codes for the Promotions page; the `commerce.discount` node applies them. */

import { normalizePromoCode, PROMOTION_KINDS, type PromotionKind } from '@commerceworker/core';
import { pricingStore } from './wire.server';

export function listPromotions() {
  return pricingStore().listPromotions();
}

export type PromotionForm = {
  code: string;
  name: string;
  kind: PromotionKind;
  value: number;
  minSubtotal: number | null;
  skus: string[] | null;
  customerId: string | null;
  validTo: number | null;
  maxRedemptions: number | null;
  perCustomerLimit: number | null;
};

/** The promotion a form describes, or why it can't be one. */
export function promotionFrom(f: FormData): PromotionForm | string {
  const s = (k: string) => String(f.get(k) ?? '').trim();
  const code = normalizePromoCode(s('code'));
  if (!code) return 'A code is letters, digits, dashes and underscores, up to 32.';
  const kind = s('kind') as PromotionKind;
  if (!PROMOTION_KINDS.includes(kind)) return 'Pick what the code does.';
  const value = kind === 'free_shipping' ? 0 : Number(s('value'));
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
  const validTo = s('validTo') ? Date.parse(`${s('validTo')}T23:59:59Z`) : null;
  if (validTo !== null && Number.isNaN(validTo)) return 'The end date is not a date.';
  const skus = s('skus')
    ? s('skus')
        .split(/[\s,]+/)
        .filter(Boolean)
    : null;
  return {
    code,
    name: s('name').slice(0, 120),
    kind,
    value,
    minSubtotal,
    skus,
    customerId: s('customerId') || null,
    validTo,
    maxRedemptions,
    perCustomerLimit,
  };
}
