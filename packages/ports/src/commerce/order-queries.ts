/**
 * Questions about many orders at once, read from the orders index: what needs attention, a filtered
 * search with its count and total, and an order id from a short reference. The workspace assistant
 * and A2A ask these; an order's own detail is its agent's. `d1OrderQueries` (packages/db) and
 * `InMemoryOrderQueries` (packages/test-kit) implement it, held to one contract.
 */
import type { Attention } from '@commerceworker/core';

export interface OrderFilter {
  readonly status?: string;
  readonly model?: string;
  readonly channel?: string;
  /** A customer's id, or text in their name. */
  readonly customer?: string;
  /** Text in the order's id, title or customer's name. */
  readonly q?: string;
  /** Bounds on the total in the base currency, at each order's own rate. */
  readonly minTotal?: number;
  readonly maxTotal?: number;
  /** Started within this many days of `now`. */
  readonly sinceDays?: number;
  readonly sort?: 'newest' | 'updated' | 'largest';
  readonly limit: number;
}

export interface FoundOrder {
  readonly id: string;
  readonly title: string;
  readonly model: string;
  readonly channel: string;
  readonly status: string;
  readonly customer: string | null;
  readonly total: number;
  readonly currency: string;
  readonly waitingOn: string | null;
  readonly waitingAt: string | null;
  readonly stoppedAt: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** An order on a shopper's list, found by the address it was placed under. */
export interface ContactOrder {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly total: number;
  readonly createdAt: number;
}

export interface OrderQueries {
  /**
   * Pending approvals (oldest first), orders that failed or rolled back in the last three days
   * (newest first), and orders waiting on something for over a day (oldest first): each list up to
   * `cap`, with the full counts.
   */
  attention(now: number, cap: number): Promise<Attention>;
  /** Orders matching the filter, and how many match and their total in the base currency. */
  find(
    filter: OrderFilter,
    now: number,
  ): Promise<{ orders: FoundOrder[]; count: number; total: number }>;
  /** The order started under this idempotency key, if any. */
  startedWithKey(key: string): Promise<{ id: string; status: string } | undefined>;
  /** Orders not in `ended`, with the flow version each runs on. */
  unfinished(
    ended: readonly string[],
  ): Promise<{ id: string; flowId: string; version: number; flow: unknown }[]>;
  /** An order id from its full id or its last characters, when only one order ends with them. */
  resolveId(ref: string): Promise<string | null>;
  /**
   * Orders placed under this address (`lower(contact_email)`, which is how a shopper's orders are
   * found: they have no account), newest first, from just after `before` (a `createdAt` and id, as
   * the last of the page before) when given, at most `limit`. An erased order has no address left
   * and is never listed.
   */
  forContact(
    email: string,
    page: { before?: { createdAt: number; id: string }; limit: number },
  ): Promise<ContactOrder[]>;
  /** Whether the order was placed under this address and not erased. */
  placedUnder(email: string, orderId: string): Promise<boolean>;
}
