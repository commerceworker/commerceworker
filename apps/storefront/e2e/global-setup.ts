import { seedCheckout } from './checkout-seed';

/** Runs once, after the dev server is up and before any test: the checkout the page tests open. */
export default function globalSetup() {
  seedCheckout();
}
