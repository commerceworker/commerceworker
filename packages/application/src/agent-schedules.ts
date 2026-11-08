import type { AgentSchedule, Scope } from '@commerceworker/domain';
import {
  assertValidCron,
  NotFoundError,
  nextCronOccurrence,
  ValidationError,
} from '@commerceworker/domain';
import type { AgentRunner } from './agent-actions';
import { recordAgentRun } from './agent-audit';
import type { AppContext } from './context';

/** The agent workflows a schedule may run. */
export const AGENT_WORKFLOWS = ['enrich', 'moderate', 'curate', 'repurpose'] as const;
export type AgentWorkflowName = (typeof AGENT_WORKFLOWS)[number];

function assertWorkflow(workflow: string): asserts workflow is AgentWorkflowName {
  if (!(AGENT_WORKFLOWS as readonly string[]).includes(workflow)) {
    throw new ValidationError([
      {
        field: 'workflow',
        message: `Unknown workflow "${workflow}" (${AGENT_WORKFLOWS.join(', ')})`,
      },
    ]);
  }
}

export interface CreateAgentScheduleInput {
  readonly workflow: string;
  /** 5-field cron expression, evaluated in UTC. */
  readonly cron: string;
  /** Restrict runs to one content type; absent = all published entries. */
  readonly contentTypeApiId?: string;
  readonly enabled?: boolean;
  readonly autoApply?: boolean;
}

/** Creates a recurring agent job. The first due run only sets the baseline —
 *  schedules process entries published *after* their previous run. */
export async function createAgentSchedule(
  ctx: AppContext,
  scope: Scope,
  input: CreateAgentScheduleInput,
): Promise<AgentSchedule> {
  assertWorkflow(input.workflow);
  assertValidCron(input.cron);
  const now = ctx.clock.now();
  const schedule: AgentSchedule = {
    id: ctx.ids.newId(),
    workflow: input.workflow,
    contentTypeApiId: input.contentTypeApiId,
    cron: input.cron,
    enabled: input.enabled ?? true,
    autoApply: input.autoApply ?? false,
    nextRunAt: nextCronOccurrence(input.cron, now).toISOString(),
    createdAt: now.toISOString(),
  };
  await ctx.store.agentSchedules.create(scope, schedule);
  return schedule;
}

export async function listAgentSchedules(ctx: AppContext, scope: Scope): Promise<AgentSchedule[]> {
  return ctx.store.agentSchedules.list(scope);
}

export interface UpdateAgentSchedulePatch {
  readonly cron?: string;
  readonly enabled?: boolean;
  readonly autoApply?: boolean;
  readonly contentTypeApiId?: string | null;
}

export async function updateAgentSchedule(
  ctx: AppContext,
  scope: Scope,
  id: string,
  patch: UpdateAgentSchedulePatch,
): Promise<AgentSchedule> {
  const existing = await ctx.store.agentSchedules.get(scope, id);
  if (!existing) throw new NotFoundError('AgentSchedule', id);
  const cron = patch.cron ?? existing.cron;
  assertValidCron(cron);
  const now = ctx.clock.now();
  const enabled = patch.enabled ?? existing.enabled;
  // Recompute the next run when the cadence changes or the schedule is
  // re-enabled with a stale nextRunAt — missed runs are skipped, never
  // burst-replayed.
  const needsRecompute =
    patch.cron !== undefined ||
    (enabled && !existing.enabled && existing.nextRunAt <= now.toISOString());
  const updated: AgentSchedule = {
    ...existing,
    cron,
    enabled,
    autoApply: patch.autoApply ?? existing.autoApply,
    contentTypeApiId:
      patch.contentTypeApiId === null
        ? undefined
        : (patch.contentTypeApiId ?? existing.contentTypeApiId),
    nextRunAt: needsRecompute ? nextCronOccurrence(cron, now).toISOString() : existing.nextRunAt,
  };
  await ctx.store.agentSchedules.save(scope, updated);
  return updated;
}

export async function deleteAgentSchedule(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<void> {
  const existing = await ctx.store.agentSchedules.get(scope, id);
  if (!existing) throw new NotFoundError('AgentSchedule', id);
  await ctx.store.agentSchedules.delete(scope, id);
}

/** Default per-run entry cap: bounds one due run's work and AI spend. */
export const AGENT_SCHEDULE_ENTRIES_PER_RUN = 25;
/** Default per-run token ceiling: a run stops (mid-batch) once exceeded. */
export const AGENT_SCHEDULE_MAX_RUN_TOKENS = 100_000;

export interface AgentScheduleRunSummary {
  /** Due schedules executed (including baseline-only first runs). */
  readonly schedules: number;
  readonly entriesProcessed: number;
  /** Schedules whose run threw (their nextRunAt still advances). */
  readonly failed: number;
  /** One entry per failed schedule, for host-side logging/alerting. */
  readonly errors: readonly { scheduleId: string; spaceId: string; message: string }[];
}

/**
 * Executes every due agent schedule. Each firing is CLAIMED first (optimistic
 * CAS on nextRunAt), so concurrent runners — worker replicas, rolling-update
 * overlap, worker + edge cron — never double-run a firing (and a crash mid-run
 * simply resumes the window at the next firing; it never re-claims this one).
 *
 * A run processes entries published strictly after the schedule's
 * `(lastRunAt, cursorEntryId)` cursor, in publish order, bounded by an entry
 * cap, a token ceiling, and the firing instant (entries published mid-run
 * wait for the next firing). Truncation OR failure both advance the cursor
 * only to the last successfully processed entry, so nothing is skipped —
 * exact across same-instant publishes via the entry-id tie-break. Every run
 * is recorded in the agent audit ledger; the caller supplies the AgentRunner
 * and (via ctx) the cost guard metering this background spend.
 */
export async function runDueAgentSchedules(
  ctx: AppContext,
  agents: AgentRunner,
  opts: { entriesPerRun?: number; maxRunTokens?: number } = {},
): Promise<AgentScheduleRunSummary> {
  const entriesPerRun = Math.max(1, opts.entriesPerRun ?? AGENT_SCHEDULE_ENTRIES_PER_RUN);
  const maxRunTokens = Math.max(1, opts.maxRunTokens ?? AGENT_SCHEDULE_MAX_RUN_TOKENS);
  const now = ctx.clock.now();
  const nowIso = now.toISOString();
  const due = await ctx.store.agentSchedules.findDue(nowIso);

  let schedules = 0;
  let entriesProcessed = 0;
  const errors: { scheduleId: string; spaceId: string; message: string }[] = [];
  for (const { scope, schedule } of due) {
    // Claim this firing: advance nextRunAt up front. Losing the race means
    // another runner owns it; a crash after this point costs one skipped
    // firing (the window resumes next time), never a double-run.
    const claimed = await ctx.store.agentSchedules.claimNextRun(
      scope,
      schedule.id,
      schedule.nextRunAt,
      nextCronOccurrence(schedule.cron, now).toISOString(),
    );
    if (!claimed) continue;
    schedules += 1;

    // First run: baseline only — watch changes going forward.
    if (!schedule.lastRunAt) {
      await ctx.store.agentSchedules.saveRunState(scope, schedule.id, { lastRunAt: nowIso });
      continue;
    }

    assertWorkflow(schedule.workflow);
    let cursor: { lastRunAt: string; cursorEntryId?: string } = {
      lastRunAt: schedule.lastRunAt,
      cursorEntryId: schedule.cursorEntryId,
    };
    try {
      const page = await ctx.store.entries.listPublished(scope, {
        contentTypeApiId: schedule.contentTypeApiId,
        after: { publishedAt: schedule.lastRunAt, entryId: schedule.cursorEntryId ?? '' },
        limit: entriesPerRun,
      });
      let runTokens = 0;
      let processed = 0;
      for (const published of page) {
        // Upper bound at the firing instant: entries published while this run
        // executes belong to the next firing (page is publish-ordered → break).
        if (published.publishedAt > nowIso) break;
        const outcome = await agents.run(schedule.workflow, {
          scope,
          entryId: published.entryId,
          autoApply: schedule.autoApply,
        });
        if (outcome.status === 'needs_review' && outcome.reviewId) {
          await agents
            .watchReview?.({ scope, reviewId: outcome.reviewId, entryId: published.entryId })
            .catch(() => {});
        }
        await recordAgentRun(ctx, scope, {
          workflow: schedule.workflow,
          entryId: published.entryId,
          status: outcome.status,
          decisions: outcome.decisions,
          usage: outcome.usage,
        });
        processed += 1;
        entriesProcessed += 1;
        cursor = { lastRunAt: published.publishedAt, cursorEntryId: published.entryId };
        runTokens += outcome.usage.inputTokens + outcome.usage.outputTokens;
        if (runTokens >= maxRunTokens) break;
      }
      // Window exhausted (no truncation): advance to the firing instant so the
      // next run's page starts at now rather than re-scanning old ground.
      const exhausted = processed === page.length && page.length < entriesPerRun;
      if (exhausted) cursor = { lastRunAt: nowIso };
    } catch (err) {
      // The cursor still points at the last SUCCESSFUL entry — the remainder
      // of the window is retried at the next firing (which the claim already
      // scheduled), so a failure defers work instead of dropping it.
      errors.push({
        scheduleId: schedule.id,
        spaceId: scope.spaceId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    await ctx.store.agentSchedules.saveRunState(scope, schedule.id, cursor);
  }
  return { schedules, entriesProcessed, failed: errors.length, errors };
}
