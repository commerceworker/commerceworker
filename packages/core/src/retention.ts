/**
 * How long each kind of row is kept before the daily retention sweep deletes it. Orders and
 * everything that is part of an order's record (payments, shipments, the stock and balance
 * ledgers, flow versions) are kept; audit events and personal data follow the deployment's own
 * settings (`auditRetentionDays`, `personalDataRetentionDays`).
 */

const DAY = 86_400_000;

export const RETENTION = {
  /** Delivered or abandoned outbound webhooks (pending ones are still being retried). */
  webhookDeliveriesMs: 90 * DAY,
  /** Per-step timings behind the metrics page (it looks back 30 days), kept longer for review. */
  nodeRunsMs: 180 * DAY,
  /** The intake log of every inbound message, accepted or rejected. */
  inboundEmailsMs: 180 * DAY,
  /** Replay receipts for signed webhooks: the signature window plus slack. */
  webhookReceiptsMs: 10 * 60_000,
  /** Handled Stripe event ids: Stripe redelivers for three days; kept well past that. */
  paymentEventsMs: 30 * DAY,
  /** UCP Idempotency-Key replays: UCP asks for 24 hours and recommends 48. */
  ucpIdempotencyMs: 2 * DAY,
  /**
   * Checkout sessions that never placed an order, after they expired. One that did is part of
   * its order's record (its line ids and ship-to are what the platform's order events show).
   */
  abandonedCheckoutsMs: 30 * DAY,
  /**
   * Chat, files, return forms and buyers of carts that ended (submitted, returned or canceled)
   * this long ago (`CartAgent.purge`). The cart's lines, quote and order stay.
   */
  endedCartsMs: 90 * DAY,
} as const;

export type RetentionPolicy = typeof RETENTION;

/**
 * Where an archive of audit events goes in the R2 bucket: named by its first event and how many
 * it holds, which together name the same events, since a batch is read in a fixed order.
 */
export const auditArchiveKey = (first: { at: number; id: string }, count: number) =>
  `audit/${new Date(first.at).toISOString().slice(0, 10)}/${first.at}-${first.id}-${count}.ndjson`;
