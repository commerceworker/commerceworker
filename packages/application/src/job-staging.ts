import type { Scope } from '@commerceworker/domain';
import type { BlobStore, BulkJob } from '@commerceworker/ports';

/**
 * Where a job chunk's staged work lives in object storage. Keyed by job, so cleanup is a prefix.
 * Its own module so the bulk-job machinery (which creates a chained job's chunks) and the job
 * kinds that stage work can all use it without importing each other.
 */
export function importChunkKey(scope: Scope, jobId: string, chunkId: string): string {
  return `imports/${scope.spaceId}/${scope.environmentId}/${jobId}/${chunkId}.json`;
}

/**
 * Discards whatever a finished or cancelled job still has staged, and the staged work of the job
 * it would have started (`config.next`) unless that one is running: work no chunk will ever read
 * again would otherwise sit in object storage indefinitely. Best-effort: storage, not truth.
 */
export async function discardStagedJob(
  blob: BlobStore,
  scope: Scope,
  job: BulkJob,
  opts: { readonly nextStarted: boolean },
): Promise<void> {
  if (!blob.deletePrefix) return;
  const prefix = (jobId: string) => `imports/${scope.spaceId}/${scope.environmentId}/${jobId}/`;
  const next = (job.config as { next?: { id?: string } } | undefined)?.next?.id;
  await blob.deletePrefix(prefix(job.id), () => false).catch(() => {});
  if (next && !opts.nextStarted) await blob.deletePrefix(prefix(next), () => false).catch(() => {});
}
