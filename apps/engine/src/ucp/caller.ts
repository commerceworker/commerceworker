/**
 * What a UCP platform's completed checkout is named by: who owns the session, the channel and
 * idempotency key of the order it places, and the `meta.ucp` pointer back to the platform. Shared by
 * the request that completes a checkout and the sweep that finishes one a crash cut short, so both
 * start the same order under the same key.
 */

import type { CheckoutCaller } from '../checkout/caller';

/** `origin` is unset only for a session claimed before it was kept; its order then has no pointer. */
export const ucpOrderCaller = (
  platformId: string,
  checkoutId: string,
  origin: string | undefined,
): CheckoutCaller => ({
  ownerId: platformId,
  channel: 'agent',
  idempotencyPrefix: 'ucp',
  ...(origin ? { meta: { ucp: { platformId, checkoutId, origin } } } : {}),
});
