import { seedAccounts } from './account-seed';
import { seedCheckout } from './checkout-seed';
import { seedIdentity } from './identity-seed';
import { seedShoppers } from './shopper-seed';

/**
 * Runs once, after the dev server is up and before any test: the checkout the page tests open, and
 * the sign-ins the account tests redeem, the signed-in shoppers their pages list, and the platform and
 * signed-in shoppers the identity-linking tests use.
 */
export default async function globalSetup() {
  seedCheckout();
  await seedShoppers();
  await seedAccounts();
  await seedIdentity();
}
