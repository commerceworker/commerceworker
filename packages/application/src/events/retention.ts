import type { AppContext } from '../context';

/** Default retention for relayed outbox rows and webhook delivery records. */
export const DEFAULT_EVENT_RETENTION_HOURS = 168;

/** Rows deleted per backend call — bounds sweep transaction size. */
const PRUNE_SLICE = 1000;
/** Slices per sweep — bounds one sweep's total work; the next sweep continues. */
const MAX_SLICES = 10;

export interface PruneEventHistorySummary {
  readonly outboxDeleted: number;
  readonly webhookDeliveriesDeleted: number;
}

/**
 * Retention sweep for the two per-event history tables that otherwise grow
 * forever: relayed outbox rows and webhook delivery records. Deletes in
 * bounded slices so a large backlog (a bulk publish) is trimmed incrementally
 * rather than in one long-running statement. Safe to run from any number of
 * workers — deletion is idempotent and only ever touches relayed/old rows.
 */
export async function pruneEventHistory(
  ctx: AppContext,
  opts: { retentionHours?: number } = {},
): Promise<PruneEventHistorySummary> {
  const hours = opts.retentionHours ?? DEFAULT_EVENT_RETENTION_HOURS;
  const before = new Date(ctx.clock.now().getTime() - hours * 3_600_000);

  let outboxDeleted = 0;
  for (let i = 0; i < MAX_SLICES; i++) {
    const n = await ctx.store.outbox.deleteRelayedBefore(before, PRUNE_SLICE);
    outboxDeleted += n;
    if (n < PRUNE_SLICE) break;
  }

  let webhookDeliveriesDeleted = 0;
  for (let i = 0; i < MAX_SLICES; i++) {
    const n = await ctx.store.webhooks.deleteDeliveriesBefore(before, PRUNE_SLICE);
    webhookDeliveriesDeleted += n;
    if (n < PRUNE_SLICE) break;
  }

  return { outboxDeleted, webhookDeliveriesDeleted };
}
