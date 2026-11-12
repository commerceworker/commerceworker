import { seedAccounts } from './account-seed';
import { seedCheckout } from './checkout-seed';
import { seedShoppers } from './shopper-seed';

/**
 * Runs once, after the dev server is up and before any test: the checkout the page tests open, and
 * the sign-ins the account tests redeem and the signed-in shoppers their pages list.
 */
export default async function globalSetup() {
  seedCheckout();
  await seedShoppers();
  await seedAccounts();
}
