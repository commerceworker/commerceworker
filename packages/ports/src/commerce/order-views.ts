/**
 * What the order-confirmation email needs beyond the message outbox. `OrderViewTokens` holds the
 * credentials an email's receipt link carries, only as hashes, each with an expiry. `OrderConfirmations`
 * reads an order as its buyer may see it and says where to write to them. `d1OrderViewTokens`
 * (packages/db) and `InMemoryOrderViewTokens` (packages/test-kit) implement the tokens, held to one
 * contract; the engine implements the reader over the order's agent.
 */
import type { BuyerOrderView } from '@commerceworker/core';

export interface OrderViewTokens {
  /** Stores a credential's hash for an order until `expiresAt` (ms). Expired ones are dropped. */
  issue(orderId: string, tokenHash: string, now: number, expiresAt: number): Promise<void>;
  /** The hashes of the order's credentials that haven't expired at `now`. */
  live(orderId: string, now: number): Promise<string[]>;
  /** Deletes every credential of these orders (an erasure takes the link away with the buyer). */
  revoke(orderIds: readonly string[]): Promise<number>;
}

/** An order to confirm: the buyer-safe view, and the address to write to (null when it has none). */
export interface ConfirmableOrder {
  readonly view: BuyerOrderView;
  readonly recipient: string | null;
}

export interface OrderConfirmations {
  /** The order as its buyer sees it, or null for an order that doesn't exist. */
  read(orderId: string): Promise<ConfirmableOrder | null>;
}
