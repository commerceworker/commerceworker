import { ForbiddenError, type Principal } from '@commerceworker/domain';
import type { Clock, SchedulerJobRun, SchedulerJobStatus } from '@commerceworker/ports';
import { redactCredentials } from '@commerceworker/redaction';
import type { AppContext } from './context';

/**
 * The engine cron's heartbeat.
 *
 * The cron fires every minute and sweeps the outbox, scheduled actions, retention and the rest;
 * nothing else would notice if it stopped. Each tick records how every sweep it ran came out, and
 * the tick itself as the `tick` job, in one write at the end (`recordSchedulerTick`). The api's
 * `/health` reads the tick's age (`schedulerState`): stale once it is older than
 * {@link SCHEDULER_STALE_AFTER_MS}. Deployment administrators read every job's last success and
 * last error (`getSchedulerStatus`), over HTTP and MCP alike. Telling someone when a sweep goes
 * stale is `scheduler-alerts.ts`.
 */

/** The job name of the cron tick itself. */
export const SCHEDULER_TICK_JOB = 'tick';

/** Five missed ticks: long enough that a slow tick or a redeploy is not an outage. */
export const SCHEDULER_STALE_AFTER_MS = 5 * 60_000;

/** An error kept for the admin is a hint, not a log: the logs hold the rest. */
export const SCHEDULER_ERROR_MAX_CHARS = 500;

/**
 * `ok` when the cron ticked within the last five minutes, `stale` when it hasn't (or never has),
 * `unknown` when the heartbeat couldn't be read.
 */
export type SchedulerState = 'ok' | 'stale' | 'unknown';

/** The outcomes of one cron tick, collected as its sweeps run and written once at its end. */
export class SchedulerTick {
  private readonly runs = new Map<string, SchedulerJobRun>();

  constructor(private readonly clock: Clock) {}

  /** The sweep finished. */
  ok(job: string): void {
    this.runs.set(job, { job, at: this.clock.now().toISOString() });
  }

  /** The sweep threw. The message is redacted (it may quote a URL or a token) and bounded. */
  fail(job: string, err: unknown): void {
    const message = redactCredentials(err instanceof Error ? err.message : err);
    this.runs.set(job, {
      job,
      at: this.clock.now().toISOString(),
      error: message.slice(0, SCHEDULER_ERROR_MAX_CHARS) || 'failed',
    });
  }

  /** Every sweep's outcome, then the tick itself: it ran, whatever its sweeps did. */
  finish(): SchedulerJobRun[] {
    return [...this.runs.values(), { job: SCHEDULER_TICK_JOB, at: this.clock.now().toISOString() }];
  }
}

/**
 * Writes one tick's outcomes: a single batch a minute, from the cron only. A failure is the
 * caller's to log; it must not fail the tick, whose sweeps already ran.
 */
export async function recordSchedulerTick(ctx: AppContext, tick: SchedulerTick): Promise<void> {
  await ctx.store.schedulerJobs.record(tick.finish());
}

function stateOf(ctx: AppContext, jobs: readonly SchedulerJobStatus[]): 'ok' | 'stale' {
  const tick = jobs.find((j) => j.job === SCHEDULER_TICK_JOB);
  if (!tick) return 'stale';
  const age = ctx.clock.now().getTime() - Date.parse(tick.lastRunAt);
  return age <= SCHEDULER_STALE_AFTER_MS ? 'ok' : 'stale';
}

/**
 * Whether the cron is ticking, and nothing more: this answers unauthenticated probes, so it
 * names no job and no error. A read failure is `unknown`, never a thrown probe.
 */
export async function schedulerState(ctx: AppContext): Promise<SchedulerState> {
  try {
    return stateOf(ctx, await ctx.store.schedulerJobs.list());
  } catch {
    return 'unknown';
  }
}

export interface SchedulerStatus {
  readonly scheduler: Exclude<SchedulerState, 'unknown'>;
  /** When the cron last ticked; absent when it never has. */
  readonly lastTickAt?: string;
  readonly staleAfterSeconds: number;
  /** Every sweep (not the tick), by name. */
  readonly jobs: readonly SchedulerJobStatus[];
}

/**
 * Each sweep's last run, success and error. Deployment administrators only (the `*` principal of
 * ADMIN_TOKEN and MCP_TOKEN): the errors describe the deployment, not any one space.
 */
export async function getSchedulerStatus(
  ctx: AppContext,
  principal: Principal,
): Promise<SchedulerStatus> {
  if (principal.spaceId !== '*') throw new ForbiddenError('Deployment administrators only');
  const rows = await ctx.store.schedulerJobs.list();
  const tick = rows.find((j) => j.job === SCHEDULER_TICK_JOB);
  return {
    scheduler: stateOf(ctx, rows),
    ...(tick ? { lastTickAt: tick.lastRunAt } : {}),
    staleAfterSeconds: SCHEDULER_STALE_AFTER_MS / 1000,
    jobs: rows.filter((j) => j.job !== SCHEDULER_TICK_JOB),
  };
}
