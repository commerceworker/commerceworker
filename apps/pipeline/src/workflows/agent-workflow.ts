import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  type Activities,
  type AgentRunResult,
  type DurableWaits,
  makeActivities,
} from '@commerceworker/agent-runtime';
import {
  curateWorkflow,
  enrichWorkflow,
  moderateWorkflow,
  publishAgentsWorkflow,
  repurposeWorkflow,
  reviewWorkflow,
} from '@commerceworker/agent-runtime/workflows';
import type { AppContext } from '@commerceworker/application';

import type { Scope } from '@commerceworker/domain';
import { doAgentCostGuardFromEnv } from '@commerceworker/platform/do/cost-guard';
import { type EdgeEnv, withJurisdiction } from '@commerceworker/platform/env';
import { makeMetrics } from '@commerceworker/platform/metrics';
import { wireEdge } from '@commerceworker/platform/wire';
import {
  type AgentWfParams,
  REVIEW_DECISION_EVENT,
  reviewInstanceId,
} from '@commerceworker/platform/workflows';
import type { AIProvider } from '@commerceworker/ports';

const workflows = {
  enrich: enrichWorkflow,
  moderate: moderateWorkflow,
  curate: curateWorkflow,
  repurpose: repurposeWorkflow,
} as const;

const STEP_CONFIG = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} as const;

/**
 * Wraps each Activities method in a `step.do`, making it a durable,
 * independently-retried step. Activities I/O is plain JSON
 * (verified: no Dates/functions cross the seam), as `step.do` requires.
 */
/**
 * Wraps each Activities method in a `step.do`.
 *
 * `prefix` scopes the step names. Step names must be DETERMINISTIC across
 * replays: a single shared counter is fine while entries run one at a time,
 * but the moment entries run concurrently the counter is assigned in
 * scheduling order, which can differ on replay and desynchronise the durable
 * log. Giving each entry its own prefixed instance keeps every name a function
 * of (entry, activity, call-index-within-that-entry), all of which are stable.
 */
function stepActivities(step: WorkflowStep, real: Activities, prefix = ''): Activities {
  let n = 0;
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      // Activities I/O is plain JSON data, but step.do's Serializable<R>
      // constraint cannot see that through the generic — hence the cast.
      step.do(`${prefix}${name}#${n++}`, STEP_CONFIG, (() => fn(...args)) as never) as Promise<R>;
  return {
    loadEntry: wrap('loadEntry', real.loadEntry.bind(real)),
    generateFields: wrap('generateFields', real.generateFields.bind(real)),
    applyFields: wrap('applyFields', real.applyFields.bind(real)),
    classify: wrap('classify', real.classify.bind(real)),
    record: wrap('record', real.record.bind(real)),
    createReview: wrap('createReview', real.createReview.bind(real)),
    armReview: wrap('armReview', real.armReview.bind(real)),
    settleReview: wrap('settleReview', real.settleReview.bind(real)),
    recordRun: wrap('recordRun', real.recordRun.bind(real)),
    retractEntry: wrap('retractEntry', real.retractEntry.bind(real)),
  };
}

/**
 * One generic Workflow entrypoint hosts all four agent workflows (selected by
 * params): the pure orchestration fns from @commerceworker/agent-runtime run
 * unchanged; only the Activities implementation differs (step-wrapped here,
 * direct calls in InProcessAgentRuntime). Deps are wired
 * per instance from bindings — this class is a composition root export.
 */
export class AgentWorkflow extends WorkflowEntrypoint<EdgeEnv, AgentWfParams> {
  override async run(
    event: WorkflowEvent<AgentWfParams>,
    step: WorkflowStep,
    // A chunked publish_agents pass returns one result PER entry; the
    // single-entry workflows return one.
  ): Promise<AgentRunResult | AgentRunResult[]> {
    const { workflow, input } = event.payload;
    // `review` and `publish_agents` are dispatched explicitly below; the map
    // holds only the single-entry workflows.
    const isMapped = workflow !== 'review' && workflow !== 'publish_agents';
    const run = isMapped ? workflows[workflow] : undefined;
    if (isMapped && !run) throw new Error(`unknown agent workflow "${workflow}"`);

    // The same wiring as the API (D1 at the primary, since agent steps write; sealed secrets; the
    // fail-closed guard against dev fakes behind a durable run). Without DB it is the in-memory
    // demo store, so demo deployments keep AGENT_RUNTIME unset and run agents in-process.
    const wired = wireEdge(this.env);
    // Durable runs meter against the background agent window (`agent:` DO
    // prefix, AI_AGENT_* ceilings when set) — previously unmetered.
    const ctx: AppContext = {
      ...wired.ctx,
      costGuard: doAgentCostGuardFromEnv(withJurisdiction(this.env)),
    };
    const ai: AIProvider = wired.ai;

    try {
      // Wrapped in a step: un-stepped side effects re-execute on replay. The
      // instance id is deterministic and "already exists" is swallowed, so a
      // replay is harmless either way — but the step keeps it durable and
      // independently retried like every other effect.
      const startWatcher = this.env.AGENT_WF
        ? (scope: Scope, reviewId: string, entryId: string): Promise<void> =>
            step.do(`startReviewWatcher#${reviewId}`, STEP_CONFIG, async () => {
              const wf = this.env.AGENT_WF as Workflow;
              await wf
                .create({
                  id: reviewInstanceId(reviewId),
                  params: { workflow: 'review', input: { scope, reviewId, entryId } },
                })
                .catch((err: unknown) => {
                  // A watcher already started (duplicate delivery) is fine.
                  const m = String(err);
                  if (!m.includes('already') && !m.includes('exists')) throw err;
                });
            })
        : undefined;
      const activities = stepActivities(step, makeActivities({ ctx, ai }));
      if (event.payload.workflow === 'publish_agents') {
        const input = event.payload.input;
        const runs = await publishAgentsWorkflow(
          activities,
          input,
          { ...(startWatcher ? { startReviewWatcher: startWatcher } : {}) },
          // Per-entry activities so concurrent entries get stable step names.
          (entryId) => stepActivities(step, makeActivities({ ctx, ai }), `${entryId}:`),
        );
        // The consumer acked at START, so it can no longer report outcomes —
        // without a terminal signal here, a chunk that fails entirely looks
        // identical to one that never ran.
        const metrics = makeMetrics(this.env.METRICS);
        metrics.count('commerceworker_agent_chunk_entries_total', input.entryIds.length, {
          outcome: 'processed',
        });
        const held = runs.filter((r) => r.status === 'held').length;
        if (held > 0) metrics.count('commerceworker_agent_runs_held_total', held);
        console.log(
          JSON.stringify({
            msg: 'publish agents chunk complete',
            entries: input.entryIds.length,
            runs: runs.length,
            held,
          }),
        );
        return runs;
      }
      if (event.payload.workflow === 'review') {
        // HITL watcher: the human decision arrives as a Workflow event;
        // waitForEvent parks durably (days) and rejects on timeout → null.
        const waits: DurableWaits = {
          awaitReviewDecision: async (reviewId, timeoutMs) => {
            try {
              const decided = await step.waitForEvent<'approved' | 'rejected'>(
                `decision:${reviewId}`,
                { type: REVIEW_DECISION_EVENT, timeout: timeoutMs },
              );
              return decided.payload ?? null;
            } catch {
              return null;
            }
          },
        };
        return await reviewWorkflow(activities, event.payload.input, waits);
      }
      if (!run) throw new Error(`unknown agent workflow "${workflow}"`);
      return await run(activities, input as import('@commerceworker/agent-runtime').WorkflowInput);
    } finally {
      // D1 holds no connection to close.
    }
  }
}
