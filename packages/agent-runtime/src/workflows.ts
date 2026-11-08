import type {
  Activities,
  AgentRunResult,
  DurableWaits,
  PublishAgentsHooks,
  PublishRunsInput,
  ReviewWatchInput,
  WorkflowInput,
} from './types';
import { DEFAULT_REVIEW_TIMEOUT_MS } from './types';

const ZERO = { inputTokens: 0, outputTokens: 0 };

/** Entries processed concurrently within one chunk. Bounded so a chunk cannot
 *  burst the AI provider or the per-instance connection budget. */
const ENTRY_CONCURRENCY = 5;

/** Persists a proposal as a pending review and shapes the needs_review result. */
async function proposeForReview(
  act: Activities,
  workflow: AgentRunResult['workflow'],
  input: WorkflowInput,
  proposed: NonNullable<AgentRunResult['proposed']>,
  decisions: string[],
  usage: AgentRunResult['usage'],
): Promise<AgentRunResult> {
  const { reviewId } = await act.createReview(input.scope, {
    workflow,
    entryId: input.entryId,
    proposed,
    notes: decisions,
  });
  return {
    workflow,
    entryId: input.entryId,
    status: 'needs_review',
    decisions,
    usage,
    proposed,
    reviewId,
  };
}

/**
 * The detached HITL watcher: armed against a pending review, it waits durably
 * for the human decision (a Cloudflare Workflow event) and
 * settles the outcome — apply-once on approval, record on rejection, stand
 * down on timeout so a later decision applies through the direct path. Runs
 * fire-and-forget (nobody awaits its result); every effect goes through `act`.
 */
export async function reviewWorkflow(
  act: Activities,
  input: ReviewWatchInput,
  waits?: DurableWaits,
): Promise<AgentRunResult> {
  const base = { workflow: 'review' as const, entryId: input.entryId, usage: ZERO };
  const armed = await act.armReview(input.scope, input.reviewId);
  if (armed === 'approved' || armed === 'rejected') {
    // Decided before the watcher armed — settle observes the decision.
    await act.settleReview(input.scope, input.reviewId, armed);
    return {
      ...base,
      status: armed === 'approved' ? 'completed' : 'rejected',
      decisions: [`decided before watch: ${armed}`],
    };
  }
  if (armed !== 'armed' || !waits) {
    await act.settleReview(input.scope, input.reviewId, 'timeout');
    return { ...base, status: 'skipped', decisions: ['no durable wait available'] };
  }
  const decision = await waits.awaitReviewDecision(
    input.reviewId,
    input.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
  );
  await act.settleReview(input.scope, input.reviewId, decision ?? 'timeout');
  return {
    ...base,
    status:
      decision === 'approved' ? 'completed' : decision === 'rejected' ? 'rejected' : 'needs_review',
    decisions: [decision ? `reviewer ${decision}` : 'timed out awaiting review'],
  };
}

/**
 * Enrich: fill empty Text/Symbol fields (other than the display field) with
 * generated values. With autoApply it saves a new draft version; otherwise it
 * returns the proposal for human review (the HITL gate). Pure orchestration —
 * every side effect goes through `act`, so this runs identically in-process or
 * as a Cloudflare Workflow.
 */
export async function enrichWorkflow(
  act: Activities,
  input: WorkflowInput,
): Promise<AgentRunResult> {
  const loaded = await act.loadEntry(input.scope, input.entryId);
  if (!loaded) {
    return {
      workflow: 'enrich',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['entry not found'],
      usage: ZERO,
    };
  }

  const empty = loaded.textFields.filter((f) => !f.hasValue && f.apiId !== loaded.displayField);
  if (empty.length === 0) {
    return {
      workflow: 'enrich',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['no empty fields to enrich'],
      usage: ZERO,
    };
  }

  const { fields, usage } = await act.generateFields({
    scope: input.scope,
    contentTypeApiId: loaded.contentTypeApiId,
    fields: empty.map(({ hasValue: _, ...f }) => f),
    entryId: input.entryId,
    context: loaded.text || '(no existing content)',
  });

  const enrichedKeys = Object.keys(fields);
  if (enrichedKeys.length === 0) {
    return {
      workflow: 'enrich',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['model returned no values'],
      usage,
    };
  }

  // HITL: low confidence (model couldn't fill every requested field) → review.
  const lowConfidence = enrichedKeys.length < empty.length;
  if (!input.autoApply || lowConfidence) {
    await act.record(input.scope, input.entryId, `enrich proposes: ${enrichedKeys.join(', ')}`);
    return proposeForReview(
      act,
      'enrich',
      input,
      fields,
      [
        `proposed ${enrichedKeys.join(', ')}`,
        lowConfidence ? 'low confidence' : 'autoApply disabled',
      ],
      usage,
    );
  }

  await act.applyFields(input.scope, input.entryId, fields, 'enrich');
  return {
    workflow: 'enrich',
    entryId: input.entryId,
    status: 'completed',
    decisions: [`enriched ${enrichedKeys.join(', ')}`],
    usage,
  };
}

/**
 * Curate: improve the values of already-filled Text/Symbol fields (other than
 * the display field) — clarity, grammar, consistency. Only fields whose
 * improved value actually differs are proposed; the same HITL gate as enrich
 * decides whether they are applied or routed to review.
 */
export async function curateWorkflow(
  act: Activities,
  input: WorkflowInput,
): Promise<AgentRunResult> {
  const loaded = await act.loadEntry(input.scope, input.entryId);
  if (!loaded) {
    return {
      workflow: 'curate',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['entry not found'],
      usage: ZERO,
    };
  }

  const filled = loaded.textFields.filter((f) => f.hasValue && f.apiId !== loaded.displayField);
  if (filled.length === 0) {
    return {
      workflow: 'curate',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['no filled fields to curate'],
      usage: ZERO,
    };
  }

  const { fields, usage } = await act.generateFields({
    scope: input.scope,
    contentTypeApiId: loaded.contentTypeApiId,
    fields: filled.map(({ hasValue: _, ...f }) => f),
    entryId: input.entryId,
    context: loaded.text,
    instruction:
      'Improve the existing values: fix grammar, tighten wording, and keep meaning and facts unchanged. Return the full improved value for every field.',
  });

  // Keep only fields the model actually changed (compared in the default locale).
  const changed: typeof fields = {};
  for (const [apiId, localized] of Object.entries(fields)) {
    if (localized[loaded.defaultLocale] !== loaded.fields[apiId]?.[loaded.defaultLocale]) {
      changed[apiId] = localized;
    }
  }
  const changedKeys = Object.keys(changed);
  if (changedKeys.length === 0) {
    return {
      workflow: 'curate',
      entryId: input.entryId,
      status: 'completed',
      decisions: ['no improvements needed'],
      usage,
    };
  }

  // HITL: low confidence (model skipped some requested fields) → review.
  const lowConfidence = Object.keys(fields).length < filled.length;
  if (!input.autoApply || lowConfidence) {
    await act.record(input.scope, input.entryId, `curate proposes: ${changedKeys.join(', ')}`);
    return proposeForReview(
      act,
      'curate',
      input,
      changed,
      [
        `proposed ${changedKeys.join(', ')}`,
        lowConfidence ? 'low confidence' : 'autoApply disabled',
      ],
      usage,
    );
  }

  await act.applyFields(input.scope, input.entryId, changed, 'curate');
  return {
    workflow: 'curate',
    entryId: input.entryId,
    status: 'completed',
    decisions: [`curated ${changedKeys.join(', ')}`],
    usage,
  };
}

/** The channel variants the repurpose agent derives from an entry's content. */
export const REPURPOSE_CHANNELS = [
  { apiId: 'summary', name: 'Summary (about 50 words)' },
  { apiId: 'socialPost', name: 'Social media post (under 280 characters)' },
  { apiId: 'emailTeaser', name: 'Email newsletter teaser (1-2 sentences)' },
] as const;

/**
 * Repurpose: derive channel variants (summary, social post, email teaser) from
 * the entry's content. The variants are not entry fields, so they are never
 * applied — the result is always a proposal (`needs_review`) recorded for a
 * human (or a downstream channel integration) to pick up.
 */
export async function repurposeWorkflow(
  act: Activities,
  input: WorkflowInput,
): Promise<AgentRunResult> {
  const loaded = await act.loadEntry(input.scope, input.entryId);
  if (!loaded?.text.trim()) {
    return {
      workflow: 'repurpose',
      entryId: input.entryId,
      status: 'skipped',
      decisions: [loaded ? 'entry has no text to repurpose' : 'entry not found'],
      usage: ZERO,
    };
  }

  const { fields, usage } = await act.generateFields({
    scope: input.scope,
    contentTypeApiId: loaded.contentTypeApiId,
    fields: REPURPOSE_CHANNELS.map((c) => ({ apiId: c.apiId, name: c.name })),
    context: loaded.text,
    instruction:
      'Repurpose the content for each requested channel. Match each channel’s format and length; keep facts unchanged.',
  });

  const variantKeys = Object.keys(fields);
  if (variantKeys.length === 0) {
    return {
      workflow: 'repurpose',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['model returned no variants'],
      usage,
    };
  }

  await act.record(input.scope, input.entryId, `repurpose proposes: ${variantKeys.join(', ')}`);
  return proposeForReview(
    act,
    'repurpose',
    input,
    fields,
    [`proposed ${variantKeys.join(', ')}`],
    usage,
  );
}

/**
 * Moderate: classify entry text; if flagged, record a hold decision (in a full
 * deployment this signals the publish flow to block). Otherwise completes clean.
 */
export async function moderateWorkflow(
  act: Activities,
  input: WorkflowInput,
): Promise<AgentRunResult> {
  const loaded = await act.loadEntry(input.scope, input.entryId);
  if (!loaded) {
    return {
      workflow: 'moderate',
      entryId: input.entryId,
      status: 'skipped',
      decisions: ['entry not found'],
      usage: ZERO,
    };
  }
  const { flagged, categories, usage } = await act.classify(input.scope, loaded.text);
  if (flagged) {
    await act.record(input.scope, input.entryId, `moderation hold: ${categories.join(', ')}`);
    return {
      workflow: 'moderate',
      entryId: input.entryId,
      status: 'held',
      decisions: [`flagged: ${categories.join(', ') || 'policy violation'}`],
      usage,
    };
  }
  return {
    workflow: 'moderate',
    entryId: input.entryId,
    status: 'completed',
    decisions: ['clean'],
    usage,
  };
}

/**
 * The full on-publish agent pass, as durable orchestration.
 *
 * This used to live in the queue consumer (`runPublishAgents`), which meant the
 * consumer had to await each run's RESULT to record it, arm the HITL watcher,
 * and retract held entries — and on Cloudflare Workflows "await the result"
 * means polling `instance.status()`, holding an invocation open for up to ten
 * minutes per entry. Moving the whole pass in here lets the consumer create the
 * instance and ack immediately: the run records its own outcome.
 *
 * It processes a CHUNK of entries so one instance covers many publishes. The
 * host picks the chunk size against the per-instance STEP ceiling — worst case
 * is ~13 steps per entry (see AGENT_CHUNK in apps/pipeline/src/index.ts).
 */
export async function publishAgentsWorkflow(
  sharedAct: Activities,
  input: PublishRunsInput,
  hooks: PublishAgentsHooks = {},
  /** Per-entry Activities, so concurrent entries get deterministic step names
   *  on engines that name their steps (Cloudflare Workflows). */
  forEntry?: (entryId: string) => Activities,
): Promise<AgentRunResult[]> {
  const names: ('enrich' | 'moderate')[] = [];
  if (input.enrich) names.push('enrich');
  if (input.moderate) names.push('moderate');

  // Entries run concurrently in bounded slices. Sequential processing made a
  // flagged entry's retraction wait on every predecessor in the chunk, which
  // is exposure time for content the classifier already held. Concurrency is
  // only safe because `forEntry` gives each entry its own step-name scope —
  // see stepActivities in apps/pipeline/src/workflows/agent-workflow.ts.
  const results: AgentRunResult[] = [];
  for (let at = 0; at < input.entryIds.length; at += ENTRY_CONCURRENCY) {
    const slice = input.entryIds.slice(at, at + ENTRY_CONCURRENCY);
    const settled = await Promise.all(
      slice.map(async (entryId) => {
        // Per-entry error boundary. The consumer acked every message in the
        // chunk when it started this instance, so an exception escaping here
        // would abort the remaining entries with no retry and no dead-letter —
        // and the most likely failure is deterministic, not transient (an
        // over-budget entry raises RateLimitedError on every attempt,
        // precisely under the bulk publishes chunking exists for).
        const act = forEntry?.(entryId) ?? sharedAct;
        try {
          return await runEntryPass(act, input, entryId, names, hooks);
        } catch (err) {
          await act
            .recordRun(input.scope, {
              workflow: names[0] ?? 'enrich',
              entryId,
              status: 'skipped',
              decisions: [`agent pass failed: ${err instanceof Error ? err.message : String(err)}`],
              usage: ZERO,
            })
            .catch(() => {});
          return [];
        }
      }),
    );
    // Flattened in slice order, so the result list stays deterministic.
    for (const r of settled) results.push(...r);
  }
  return results;
}

/** One entry's pass: enrich (first, so moderation sees enriched content), then
 *  moderate, recording each run and retracting anything held. */
async function runEntryPass(
  act: Activities,
  input: PublishRunsInput,
  entryId: string,
  names: readonly ('enrich' | 'moderate')[],
  hooks: PublishAgentsHooks,
): Promise<AgentRunResult[]> {
  {
    const perEntry: AgentRunResult[] = [];
    for (const name of names) {
      // Enrich before moderate so moderation sees the enriched content.
      const run =
        name === 'enrich'
          ? await enrichWorkflow(act, { scope: input.scope, entryId, autoApply: input.autoApply })
          : await moderateWorkflow(act, { scope: input.scope, entryId });

      if (run.status === 'needs_review' && run.reviewId) {
        // Best-effort: without a watcher the decision still applies through the
        // direct path, so a failure here must not fail the pass.
        await hooks.startReviewWatcher?.(input.scope, run.reviewId, entryId).catch(() => {});
      }
      await act.recordRun(input.scope, {
        workflow: name,
        entryId,
        status: run.status,
        decisions: [...run.decisions],
        usage: run.usage,
      });
      perEntry.push(run);
    }

    // A held entry is already live (agents run off entry.published), so take it
    // out of delivery rather than only noting the hold.
    if (perEntry.some((r) => r.workflow === 'moderate' && r.status === 'held')) {
      // Record the retraction only AFTER it succeeds: the ledger must not
      // claim flagged content was pulled from delivery when it wasn't.
      await act.retractEntry(input.scope, entryId, 'moderate');
      await act.recordRun(input.scope, {
        workflow: 'moderate',
        entryId,
        status: 'held',
        decisions: ['retracted from delivery pending review'],
        usage: ZERO,
      });
    }
    return perEntry;
  }
}
