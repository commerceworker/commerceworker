import { type EntryFields, type Scope, ValidationError } from '@commerceworker/domain';
import type { AppContext } from './context';
import { type CreateEntryInput, createEntry } from './entries';
import { publishEntriesTx, publishEntry, unpublishEntriesTx, unpublishEntry } from './publishing';

/** Largest batch a single bulk call accepts. */
export const BULK_LIMIT = 1000;

/** Ids per transaction inside a bulk call — bounds statement/lock footprint. */
export const BULK_TX_CHUNK = 200;

export type BulkEntryAction = 'publish' | 'unpublish';

/** Per-item outcome — the batch never fails as a whole; failures are captured. */
export interface BulkItemResult {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface BulkSummary {
  readonly action: string;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly BulkItemResult[];
}

function assertBatch(n: number): void {
  if (n === 0) throw new ValidationError([{ field: 'ids', message: 'No items provided' }]);
  if (n > BULK_LIMIT) {
    throw new ValidationError([{ field: 'ids', message: `Batch exceeds ${BULK_LIMIT} items` }]);
  }
}

function summarize(action: string, results: BulkItemResult[]): BulkSummary {
  const succeeded = results.filter((r) => r.ok).length;
  return { action, total: results.length, succeeded, failed: results.length - succeeded, results };
}

/**
 * Publishes or unpublishes many entries in one call. Each item is independent:
 * one failure never aborts the rest, and the per-item outcome is returned.
 *
 * Items are processed in chunked batch transactions (~10 statements per
 * {@link BULK_TX_CHUNK} ids instead of ~8 per id). Validation failures are
 * partitioned inside the batch; if a chunk fails at the database level, it
 * falls back to the single-item path so one poison row is isolated instead of
 * failing its 199 neighbors.
 */
export async function bulkEntryAction(
  ctx: AppContext,
  scope: Scope,
  action: BulkEntryAction,
  ids: readonly string[],
): Promise<BulkSummary> {
  assertBatch(ids.length);
  const runTx = action === 'publish' ? publishEntriesTx : unpublishEntriesTx;
  const runOne = action === 'publish' ? publishEntry : unpublishEntry;
  const results: BulkItemResult[] = [];
  for (let at = 0; at < ids.length; at += BULK_TX_CHUNK) {
    const chunk = ids.slice(at, at + BULK_TX_CHUNK);
    try {
      const batch = await ctx.store.withTransaction((tx) => runTx(ctx, tx, scope, chunk));
      const errorById = new Map(batch.failures.map((f) => [f.id, f.error]));
      for (const id of chunk) {
        const error = errorById.get(id);
        results.push(error ? { id, ok: false, error } : { id, ok: true });
      }
    } catch {
      // The chunk transaction itself failed (constraint violation, connection
      // loss mid-batch): retry item-by-item to isolate the poison row. If the
      // failure was actually a lost COMMIT ack, the retry re-publishes
      // already-published entries and emits duplicate outbox events — safe
      // under the platform's at-least-once delivery + idempotent consumers.
      for (const id of chunk) {
        try {
          await runOne(ctx, scope, id);
          results.push({ id, ok: true });
        } catch (e) {
          results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }
  return summarize(action, results);
}

export interface BulkCreateItemResult {
  /** Index of the item in the request, so callers can correlate failures. */
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Creates many draft entries in one call. Each is validated and created
 * independently; the per-item outcome (new id or error) is returned.
 */
export async function bulkCreateEntries(
  ctx: AppContext,
  scope: Scope,
  items: readonly CreateEntryInput[],
): Promise<BulkSummary> {
  assertBatch(items.length);
  const results: BulkItemResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as { contentTypeApiId: string; fields: EntryFields };
    try {
      const { entry } = await createEntry(ctx, scope, item);
      results.push({ id: entry.id, ok: true });
    } catch (e) {
      results.push({ id: `#${i}`, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return summarize('create', results);
}
