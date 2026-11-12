/**
 * Checkout sessions (a UCP platform's, or a hosted buyer's): each owner's checkouts, written over the version they were
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
  /** Who owns the session, or null when there is none: for a caller that must compare the owner itself. */
  ownerOf(id: string): Promise<string | null>;
  /**
   * Hands a session from owner `from` to `to`, once: only while it is `from`'s, open and unexpired
   * at `now`, so of two redemptions of one start link exactly one wins. The session as `to` now
   * owns it, or null.
   */
  transfer(id: string, from: string, to: string, now: number): Promise<CheckoutSession | null>;
  /**
   * Hosted sessions (their owner is a redeemed buyer's, `hosted:…`) claimed for completion
   * (`complete_in_progress`) and not written since `before`, oldest first: a payment that began and
   * never finished, which holds a card for nothing until someone finishes or releases it.
   */
  stuckHosted(before: number, limit: number): Promise<CheckoutSession[]>;
  /** The session that placed `orderId`, whoever owns it. */
  forOrder(orderId: string): Promise<CheckoutSession | null>;
}
