/**
 * Who a checkout runs for. The checkout is the same whatever fronts it (UCP's REST and MCP, a
 * hosted page); the caller supplies what differs: whose sessions these are, the channel and the
 * idempotency namespace of the orders it places, what it adds to the order's `meta`, and the
 * protocol issues it holds a session to.
 */

import type { CheckoutIssue, CheckoutSession, OrderChannel } from '@commerceworker/core';

export type CheckoutCaller = {
  /** Owns the sessions: `load` and every write are scoped to it. */
  ownerId: string;
  /** The channel of the orders this caller places. */
  channel: OrderChannel;
  /** The order's idempotency key is `<prefix>:<session id>`, so two callers never share one. */
  idempotencyPrefix: string;
  /** Added to the order's `meta` after the quote's own keys (UCP's `meta.ucp` pointer). */
  meta?: Record<string, unknown>;
  /** Issues this caller's protocol adds on top of the checkout's own. */
  protocolIssues?: (s: CheckoutSession) => CheckoutIssue[];
  /** Whether the pickup stores found are kept on the session (default). UCP keeps them only when the platform negotiated fulfillment. */
  pickupStores?: boolean;
};
