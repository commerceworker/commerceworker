/**
 * A recurring agent job: on a cron cadence, run one agent workflow over the
 * entries published since the schedule's previous run (delta-based, so a run
 * never reprocesses the whole space). Engine-agnostic — the cron sweeper
 * polls for due schedules and executes them through the same AgentRunner as
 * on-publish agents, on whichever runtime is wired (in-process or
 * Cloudflare Workflows).
 */

export interface AgentSchedule {
  readonly id: string;
  /** Agent workflow to run (enrich | moderate | curate | repurpose). */
  readonly workflow: string;
  /** Restrict to one content type; absent = all published entries. */
  readonly contentTypeApiId?: string;
  /** 5-field cron expression, evaluated in UTC. */
  readonly cron: string;
  readonly enabled: boolean;
  /** Apply agent output automatically; false routes proposals to review. */
  readonly autoApply: boolean;
  /**
   * Window cursor: the publish instant of the last processed entry (or the
   * run instant when the window completed). The next run processes entries
   * strictly after `(lastRunAt, cursorEntryId)` in publish order. Unset until
   * the first run, which only sets the baseline (schedules watch changes
   * going forward).
   */
  readonly lastRunAt?: string;
  /**
   * Entry-id tie-break for `lastRunAt` — same-transaction publishes share a
   * publish instant, so a truncated run resumes exactly at the boundary
   * instead of skipping (or reprocessing) same-instant siblings.
   */
  readonly cursorEntryId?: string;
  /** ISO-8601 instant of the next due run (derived from `cron`). */
  readonly nextRunAt: string;
  readonly createdAt: string;
}

/** True when the schedule is enabled and its next run time has arrived. */
export function isScheduleDue(schedule: AgentSchedule, now: string): boolean {
  return schedule.enabled && now >= schedule.nextRunAt;
}
