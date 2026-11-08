/**
 * Three small logs the engine keeps: the intake log of every inbound order email, accepted or
 * not; the payment processor's events already handled (so a redelivered one is a duplicate); and
 * each person's assistant usage per day, which their daily token budget is counted against. Each is
 * pruned by the retention sweep. `d1IntakeLog`, `d1PaymentEventLog` and `d1UsageStore`
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

export interface PaymentEventLog {
  /** Claims an event to handle: false when it was handled (or is being handled) already. */
  claim(id: string, provider: string, type: string, now: number): Promise<boolean>;
  /** Notes the order an event was about. */
  link(id: string, orderId: string): Promise<void>;
  /** Frees an event whose handling failed, so a redelivery handles it. */
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
