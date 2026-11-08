import { DomainError, type Scope } from '@commerceworker/domain';
import type { BlobStore, BulkItemFailure, BulkJob, BulkJobChunk } from '@commerceworker/ports';
import { actingForJob, type BulkChunkOutcome } from './bulk-jobs';
import type { AppContext } from './context';
import { purgeEntry, restoreEntry, trashEntry } from './entries';

/**
 * The entry trash's bulk actions (`trash`, `restore`, `purge`) as resumable bulk jobs: the same
 * chunked, CAS-claimed, swept machinery as bulk publishing (`bulk-jobs.ts`). Each entry goes
 * through the use-case its single-entry route calls, so a job keeps every rule one entry at a time
 * keeps: trashing unpublishes a live entry first, restoring refuses a unique value taken since,
 * purging works only from the trash and refuses an entry published entries still link to (a job
 * never forces it). Each refusal is that entry's failure in the job's report.
 */

export interface EntryTrashChunkDeps {
  /** Where a purged entry's archived version bodies live, removed with it (`purgeEntry`). */
  readonly blob?: BlobStore;
}

/**
 * The chunk runner for entry trash jobs. Safe to run twice (a redelivery, the stall sweep): an
 * entry already where the action puts it counts as a success without being touched again: one
 * already in the trash for `trash`, one already out of it for `restore`, and one already gone for
 * `purge`. So a re-run never reports what the first run did as failures, at the price that a
 * purge of an id that never existed reads as done.
 */
export function entryTrashChunkRunner(
  ctx: AppContext,
  deps: EntryTrashChunkDeps = {},
): (scope: Scope, job: BulkJob, chunk: BulkJobChunk) => Promise<BulkChunkOutcome> {
  return async (scope, job, chunk) => {
    const acting = actingForJob(ctx, job);
    // One read for the chunk, so entries already done are skipped without a transaction each.
    const status = new Map(
      (await ctx.store.entries.getMany(scope, chunk.entryIds)).map((e) => [
        e.entry.id,
        e.entry.status,
      ]),
    );
    const failures: BulkItemFailure[] = [];
    for (const id of chunk.entryIds) {
      const current = status.get(id);
      try {
        switch (job.action) {
          case 'trash':
            if (current === undefined) failures.push({ id, error: 'Entry not found' });
            else if (current !== 'archived') await trashEntry(acting, scope, id);
            break;
          case 'restore':
            if (current === undefined) failures.push({ id, error: 'Entry not found' });
            else if (current === 'archived') await restoreEntry(acting, scope, id);
            break;
          case 'purge':
            if (current !== undefined) {
              await purgeEntry(ctx, scope, id, deps.blob ? { blob: deps.blob } : {});
            }
            break;
          default:
            throw new Error(`Not an entry trash action: ${job.action}`);
        }
      } catch (err) {
        // A rule's refusal is this entry's outcome; anything else (the database) fails the chunk,
        // which is released and retried whole.
        if (!(err instanceof DomainError)) throw err;
        failures.push({ id, error: err.message });
      }
    }
    return { succeeded: chunk.entryIds.length - failures.length, failures };
  };
}
