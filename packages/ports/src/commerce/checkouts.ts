/**
 * Agentic checkout sessions (UCP): each platform's checkouts, written over the version they were
 * read at, so two writes racing on one session can't both land, and found by the order a completed
 * one placed. `d1CheckoutSessions` (packages/db) and `InMemoryCheckoutSessions` (packages/test-kit)
 * implement it, held to one contract.
 */
import type { CheckoutSession } from '@commerceworker/core';

export interface CheckoutSessionStore {
  /** Records a new session. */
  create(session: CheckoutSession): Promise<void>;
  /** A platform's session; another platform's reads as missing, as its id says nothing. */
  load(ownerId: string, id: string): Promise<CheckoutSession | null>;
  /** Writes `next` over the version it was read at; false when someone wrote in between. */
  save(next: CheckoutSession, readVersion: number): Promise<boolean>;
  /** The session that placed `orderId`, whoever owns it. */
  forOrder(orderId: string): Promise<CheckoutSession | null>;
}
