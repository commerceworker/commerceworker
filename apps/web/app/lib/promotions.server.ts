/** Promotions for the Promotions page; the `commerce.discount` node applies them. */

import { pricingStore } from './wire.server';

export function listPromotions() {
  return pricingStore().listPromotions();
}
