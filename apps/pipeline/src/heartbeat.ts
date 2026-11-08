import {
  type AppContext,
  alertOnSchedulerTick,
  recordSchedulerTick,
  type ScheduledJob,
  type SchedulerAlertOutcome,
  SchedulerTick,
} from '@commerceworker/application';
import type { EmailSender, SchedulerJobStatus } from '@commerceworker/ports';
import { redactCredentials } from '@commerceworker/redaction';

/** The cron's sweeps, by the name the heartbeat records them under. */
export const CRON_JOBS = {
  prune: 'event-history-prune',
  reseal: 'secrets-reseal',
  scheduledActions: 'scheduled-actions',
  assetExpiry: 'asset-expiry',
  relay: 'outbox-relay',
  bulkResume: 'bulk-resume',
  purgeResume: 'environment-purge-resume',
  versionArchive: 'version-archive',
  agentSchedules: 'agent-schedules',
  abandonedUploads: 'abandoned-uploads',
  abandonedMultipart: 'abandoned-multipart-uploads',
  expiredZips: 'expired-zips',
  taxonomyRepair: 'taxonomy-repair',
  trashRetention: 'trash-retention',
} as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How often each sweep is due, as `scheduled` in ./index.ts runs it. The stale alerts read it. */
export const CRON_EVERY: Record<keyof typeof CRON_JOBS, number> = {
  prune: HOUR,
  abandonedMultipart: HOUR,
  expiredZips: HOUR,
  abandonedUploads: HOUR,
  trashRetention: HOUR,
  reseal: DAY,
  taxonomyRepair: DAY,
  scheduledActions: MINUTE,
  assetExpiry: MINUTE,
  relay: MINUTE,
  bulkResume: MINUTE,
  purgeResume: MINUTE,
  versionArchive: MINUTE,
  agentSchedules: MINUTE,
};

/**
 * The sweeps a persistent deployment's cron runs, by the same switches `scheduled` checks: a
 * sweep the deployment has turned off is not expected, so it never reads as stale.
 */
export function cronSchedule(on: {
  readonly queue: boolean;
  readonly versionArchive: boolean;
  readonly agentSchedules: boolean;
}): ScheduledJob[] {
  const off = new Set<keyof typeof CRON_JOBS>([
    ...(on.queue ? [] : (['relay'] as const)),
    ...(on.versionArchive ? [] : (['versionArchive'] as const)),
    ...(on.agentSchedules ? [] : (['agentSchedules'] as const)),
  ]);
  return (Object.keys(CRON_JOBS) as (keyof typeof CRON_JOBS)[])
    .filter((k) => !off.has(k))
    .map((k) => ({ job: CRON_JOBS[k], everyMs: CRON_EVERY[k] }));
}

/** The daily taxonomy repair runs on the 04:15 UTC tick of the every-minute cron. */
export function isTaxonomyRepairTick(scheduledTime: number): boolean {
  const at = new Date(scheduledTime);
  return at.getUTCHours() === 4 && at.getUTCMinutes() === 15;
}

/** A tick's heartbeat, started when the tick starts. */
export const startTick = (ctx: AppContext) => new SchedulerTick(ctx.clock);

/**
 * Runs one sweep and records how it came out. A failure is recorded and handed to `onError`
 * (its log line and metric) and never thrown: one sweep must not skip the rest of the tick, and
 * the outbox relay is the crash backstop for everything else.
 */
export async function sweep(
  tick: SchedulerTick,
  job: string,
  run: () => Promise<unknown>,
  onError: (err: unknown) => void,
): Promise<void> {
  try {
    await run();
    tick.ok(job);
  } catch (err) {
    tick.fail(job, err);
    onError(err);
  }
}

/** What the end of the tick needs to tell someone about a stale sweep. */
export interface TickAlerts {
  readonly schedule: readonly ScheduledJob[];
  readonly email?: EmailSender;
}

/**
 * Writes the tick's heartbeat: one batch, at the end of the tick, whatever its sweeps did. A
 * failed write is logged, not thrown: the sweeps already ran, and the next tick writes again (the
 * api then reads the scheduler stale only if writes keep failing for five minutes).
 *
 * With `alerts`, it then evaluates the stale alerts against the heartbeat as it stood before the
 * write (read first, for the gap since the last tick). Alerting never fails the tick either: a
 * failure is logged and the next tick evaluates again.
 */
export async function finishTick(
  ctx: AppContext,
  tick: SchedulerTick,
  alerts?: TickAlerts,
): Promise<boolean> {
  let before: SchedulerJobStatus[] | undefined;
  if (alerts) {
    try {
      before = await ctx.store.schedulerJobs.list();
    } catch (err) {
      console.error('scheduler alerts skipped: heartbeat unreadable', redactCredentials(err));
    }
  }
  try {
    await recordSchedulerTick(ctx, tick);
  } catch (err) {
    console.error('scheduler heartbeat write failed', redactCredentials(err));
    return false;
  }
  if (alerts && before) {
    try {
      const email = alerts.email;
      logAlerts(
        await alertOnSchedulerTick(ctx, email ? { email } : {}, {
          schedule: alerts.schedule,
          before,
          runs: tick.finish(),
        }),
      );
    } catch (err) {
      console.error('scheduler alerts failed', redactCredentials(err));
    }
  }
  return true;
}

/**
 * One line per episode opened or resolved and per notice: the log is the channel that always
 * works, with or without email (a Workers Logs alert can match `scheduler job stale`).
 */
function logAlerts(outcome: SchedulerAlertOutcome): void {
  for (const e of outcome.opened) {
    console.error(
      JSON.stringify({
        msg: 'scheduler job stale',
        job: e.job,
        lastSuccessAt: e.lastSuccessAt ?? null,
        lastError: e.lastError ?? null,
      }),
    );
  }
  for (const e of outcome.resolved) {
    console.log(
      JSON.stringify({
        msg: e.job === 'tick' ? 'scheduler resumed' : 'scheduler job recovered',
        job: e.job,
        since: e.job === 'tick' ? e.lastSuccessAt : e.detectedAt,
        resolution: e.resolution,
      }),
    );
  }
  for (const n of outcome.notices) {
    const line = JSON.stringify({ msg: 'scheduler alert notice', ...n });
    if (n.state === 'sent') console.log(line);
    else console.warn(line);
  }
}
