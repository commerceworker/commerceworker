import { NotFoundError, type Scope } from '@commerceworker/domain';
import type { BulkItemFailure, BulkJob } from '@commerceworker/ports';
import type { AppContext } from './context';

/**
 * How far back in an environment's jobs an install is looked for. A starter installs into a new
 * space, so its phases are that environment's latest jobs; this leaves room for a few hundred
 * others started while it runs.
 */
const STARTER_INSTALL_SCAN = 200;

/** Where a space starter's background install has got to. */
export interface StarterInstall {
  readonly install: string;
  readonly starter: string;
  /** The phase running now, or the last one to run (1-based), of `steps`. */
  readonly step: number;
  readonly steps: number;
  readonly phase: string;
  readonly title: string;
  /** The bulk job of that phase (its report is at `…/bulk/jobs/{id}/report`). */
  readonly jobId: string;
  /**
   * `completed` once the last phase finished cleanly; `failed` when a phase finished with a
   * failure or was cancelled, which stops the install there (the phases after it never start).
   */
  readonly status: 'running' | 'completed' | 'failed';
  /** What failed in the phase that stopped the install. */
  readonly failures?: readonly BulkItemFailure[];
}

interface InstallJobConfig {
  readonly starter?: unknown;
  readonly install?: unknown;
  readonly phase?: unknown;
  readonly title?: unknown;
  readonly step?: unknown;
  readonly steps?: unknown;
}

const configOf = (job: BulkJob): InstallJobConfig => (job.config ?? {}) as InstallJobConfig;
const stepOf = (job: BulkJob): number => {
  const step = configOf(job).step;
  return typeof step === 'number' ? step : 0;
};

/**
 * Reads a starter install's progress from the `starter_install` jobs it has started in this
 * environment, one per phase, chained (`config.next`) so each starts only after the one before
 * finished cleanly. The latest phase's job says where it is: running, failed (finished with a
 * failure, or cancelled) or, for the last phase finished cleanly, completed. Read-only: two
 * queries at most (the jobs, and a failed phase's chunks).
 */
export async function getStarterInstall(
  ctx: AppContext,
  scope: Scope,
  installId: string,
): Promise<StarterInstall> {
  const jobs = (await ctx.store.bulkJobs.listJobs(scope, { limit: STARTER_INSTALL_SCAN })).filter(
    (j) => j.action === 'starter_install' && configOf(j).install === installId,
  );
  const latest = jobs.reduce<BulkJob | undefined>(
    (best, j) => (best === undefined || stepOf(j) > stepOf(best) ? j : best),
    undefined,
  );
  if (!latest) throw new NotFoundError('StarterInstall', installId);

  const config = configOf(latest);
  const steps = typeof config.steps === 'number' ? config.steps : stepOf(latest);
  const stopped =
    latest.status === 'cancelled' || (latest.status === 'completed' && latest.failed > 0);
  const status: StarterInstall['status'] = stopped
    ? 'failed'
    : latest.status === 'completed' && stepOf(latest) >= steps
      ? 'completed'
      : // A clean phase short of the last has already started the next one (the same write
        // finalizes it); until that job is read, the install is still running.
        'running';

  const failures = stopped
    ? (await ctx.store.bulkJobs.listChunks(scope, latest.id)).flatMap((c) => c.failures)
    : [];
  return {
    install: installId,
    starter: typeof config.starter === 'string' ? config.starter : '',
    step: stepOf(latest),
    steps,
    phase: typeof config.phase === 'string' ? config.phase : '',
    title: typeof config.title === 'string' ? config.title : '',
    jobId: latest.id,
    status,
    ...(stopped
      ? {
          failures:
            failures.length > 0 || latest.status !== 'cancelled'
              ? failures
              : [{ id: latest.id, error: 'The install was stopped' }],
        }
      : {}),
  };
}
