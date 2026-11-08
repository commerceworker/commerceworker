/**
 * Bulk work's tallies and words, whatever it acted on: a run of single calls in this tab (the
 * asset library's `runBulk`) or a job on the server, for assets and entries alike.
 */
import type { BulkJobReport, BulkJobSummary } from './management';

/** The outcome of running one action over several items (assets, entries). */
export interface BulkOutcome {
  readonly done: number;
  readonly failed: number;
  /** Which ones failed and why, so the screen can name them and keep them selected. */
  readonly failures?: readonly { readonly id: string; readonly error: string }[];
}

/**
 * "Published 3 assets", or "Published 2 of 3 assets; 1 failed". `nouns` names what was acted on
 * (singular, plural): assets unless said otherwise.
 */
export function bulkSummary(
  verb: string,
  outcome: BulkOutcome,
  nouns: readonly [string, string] = ['asset', 'assets'],
): string {
  const total = outcome.done + outcome.failed;
  const noun = total === 1 ? nouns[0] : nouns[1];
  if (outcome.failed === 0) return `${verb} ${total} ${noun}`;
  return `${verb} ${outcome.done} of ${total} ${noun}; ${outcome.failed} failed`;
}

/** A job's tally as a {@link BulkOutcome}, so it is summed up in the same words as a loop. */
export const jobOutcome = (job: BulkJobSummary): BulkOutcome => ({
  done: job.succeeded,
  failed: job.failed,
});

/**
 * What a job's report says failed, by item: its name where the report gave one (an asset's title
 * or file name), else the name the screen has it loaded under (`known`: a batch that failed as a
 * whole names nothing), and only then its id.
 */
export function jobFailures(
  report: BulkJobReport,
  known: ReadonlyMap<string, string> = new Map(),
): { readonly id: string; readonly name: string; readonly error: string }[] {
  return report.chunks.flatMap((c) =>
    c.failures.map((f) => ({ id: f.id, name: f.name ?? known.get(f.id) ?? f.id, error: f.error })),
  );
}
