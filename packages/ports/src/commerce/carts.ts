/**
 * The carts index the CartAgent keeps in D1 beside its own state: one row per cart, so the Carts
 * page lists carts and a plugin's session finds its cart without waking every agent. The agent's
 * state is the truth; the row is its projection. `d1CartRecords` (packages/db) and
 * `InMemoryCartRecords` (packages/test-kit) implement it, held to one contract.
 */
import type { CartIndexRow } from '@commerceworker/core';

export interface CartRecord {
  readonly id: string;
  readonly status: string;
  readonly pluginId: string | null;
  /** Until when an external cart's gate admits its buyer. */
  readonly expiresAt: number | null;
  readonly purgedAt: number | null;
}

export interface StaffCart {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly customerId: string | null;
  readonly customer: string | null;
  readonly flowId: string;
  readonly orderId: string | null;
  readonly updatedAt: number;
}

export interface CartRecords {
  /**
   * Writes the cart's row: created on its first write; later writes change what can change (title,
   * status, customer, order, times, buyer), never who made it or the plugin session it belongs to.
   */
  index(row: CartIndexRow): Promise<void>;
  /**
   * Moves an open (or locked) cart's expiry on. Only the time, and only while the row says the
   * cart is open, so a cancel, return or erasure indexing at the same time keeps what it wrote.
   */
  extendExpiry(id: string, until: number): Promise<void>;
  /** Marks the cart purged (retention cleared its chat, files and buyer). */
  markPurged(id: string): Promise<void>;
  /** The cart's row, or undefined when no cart has the id. */
  find(id: string): Promise<CartRecord | undefined>;
  /** Carts, most recently changed first: of a status, and plugins' carts too when `external`. */
  list(f: { status?: string; external?: boolean; limit: number }): Promise<CartIndexRow[]>;
  /** Staff carts (not a plugin's), most recently changed first, with their customer's name. */
  staffCarts(f: { status?: string; limit: number }): Promise<StaffCart[]>;
  /** The cart a plugin opened for its session, if any. */
  forSession(pluginId: string, sessionRef: string): Promise<CartRecord | undefined>;
}
