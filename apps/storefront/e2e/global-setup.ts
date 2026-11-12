import { seedCheckout } from './checkout-seed';
import { seedShoppers } from './shopper-seed';

/**
 * Runs once, after the dev server is up and before any test: the checkout the page tests open, and
 * the sign-ins the account tests redeem.
 */
export default async function globalSetup() {
  seedCheckout();
  await seedShoppers();
}
