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

/**
 * Where a daily copy of not-yet-expired audit events goes: named by the chain range it holds and
 * the start of its last event's hash. The range and hash name the same events, so a key is never
 * written with different content; after a restore the chain's new events reuse the lost ones'
 * seqs but not their hashes, so they land under a key of their own.
 */
export const auditCopyKey = (from: number, to: number, hash: string) =>
  `audit/chain/${String(from).padStart(10, '0')}-${String(to).padStart(10, '0')}-${hash.slice(0, 12)}.ndjson`;

/** What `auditCopyKey` names, or null for a key that isn't one. */
export function parseAuditCopyKey(key: string) {
  const m = /^audit\/chain\/(\d{10})-(\d{10})-([0-9a-f]{12})\.ndjson$/.exec(key);
  return m ? { key, from: Number(m[1]), to: Number(m[2]), hash: m[3]! } : null;
}

/**
 * Where the chain's head is anchored: one object an hour, `audit/anchors/<date>/<hour>.json`. It
 * lives under the bucket's locked `audit/` prefix, so a written anchor can be neither changed nor
 * deleted; one key per hour makes the write once a day-hour, whichever run gets there first.
 */
export const auditAnchorKey = (at: number) => {
  const iso = new Date(at).toISOString();
  return `audit/anchors/${iso.slice(0, 10)}/${iso.slice(11, 13)}.json`;
};

/** Days back `latest` looks for an anchor before it reports there is none. */
export const AUDIT_ANCHOR_LOOKBACK_DAYS = 7;
