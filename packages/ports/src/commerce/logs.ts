/**
 * Four small logs: the intake log of every inbound order email, accepted or
 * not; the payment processor's events already handled (so a redelivered one is a duplicate); and
 * each person's assistant usage per day, which their daily token budget is counted against; and the
 * signed webhooks the web app already took. Each is pruned by the retention sweep. `d1IntakeLog`, `d1PaymentEventLog` and `d1UsageStore`
 * (packages/db) and their in-memory twins (packages/test-kit) implement them, held to one contract.
 */

export interface InboundEmail {
  readonly id: string;
  readonly messageId: string;
  readonly mailbox: string;
  readonly sender: string;
  readonly subject: string;
  /** `accepted`, `rejected` or `duplicate`. */
  readonly status: string;
  readonly reason?: string | null;
  readonly orderId?: string | null;
  readonly r2Key?: string | null;
  readonly attachments?: number;
  readonly receivedAt: number;
}

export interface IntakeLog {
  /** Records an inbound email once by message id: a repeat keeps the first. */
  record(email: InboundEmail): Promise<void>;
}

/**
 * What a claim came to: `claimed` (this taker handles the event), `done` (handled already),
 * `processing` (another taker holds it and is not yet stale: ask again later) or `poisoned` (it threw
 * too often; an operator decides).
 */
export type EventClaim = 'claimed' | 'done' | 'processing' | 'poisoned';

export interface PaymentEventLog {
  /**
   * Claims an event to handle. A new id, a `released` one, and one still `processing` after
   * `staleMs` (its taker died) are claimed, by one guarded write, so of any number of concurrent
   * takers exactly one gets `claimed`.
   */
  claim(
    id: string,
    provider: string,
    type: string,
    now: number,
    staleMs: number,
  ): Promise<EventClaim>;
  /** Notes the order an event was about. */
  link(id: string, orderId: string): Promise<void>;
  /** Marks a claimed event handled, with its outcome (`handled`, `ignored`). */
  finish(id: string, outcome: string): Promise<void>;
  /** Gives a claim back without counting a failure (the answer was `retry`): a redelivery handles it. */
  release(id: string): Promise<void>;
  /**
   * Counts a failed handling and gives the claim back. With `poisonAfter`, the failure that reaches
   * it marks the event `poisoned` instead, and `poisoned` is true for that one call only.
   */
  fail(id: string, poisonAfter?: number): Promise<{ failures: number; poisoned: boolean }>;
  /** Where the provider's reconciliation left off (a Unix second), or undefined before its first run. */
  cursor(provider: string): Promise<number | undefined>;
  /** Moves the cursor forward; an older value than the stored one changes nothing. */
  advance(provider: string, cursor: number, now: number): Promise<void>;
}

/**
 * Signed webhooks already delivered, by their signature: a replay of one is refused while the
 * signature is still valid, and a delivery that failed is given back so its retry goes through.
 */
export interface WebhookReceipts {
  /**
   * Records a delivered signature at `now`, dropping receipts older than `ttlMs` in the same
   * round trip; false when it was already recorded.
   */
  claim(id: string, now: number, ttlMs: number): Promise<boolean>;
  /** Forgets a receipt, so the signature can be delivered again. */
  release(id: string): Promise<void>;
}

export interface UsageStore {
  /** Tokens a person used on a day (`2026-10-17`). */
  tokens(principalId: string, day: string): Promise<number>;
  /** Adds a finished turn's tokens to the person's day. */
  add(principalId: string, day: string, tokens: number): Promise<void>;
  /** Drops days before `day`. Returns how many rows. */
  prune(beforeDay: string): Promise<number>;
}
