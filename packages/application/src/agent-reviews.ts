import type { AgentReview, EntryFields, Principal, Scope } from '@commerceworker/domain';
import {
  agentActor,
  ConflictError,
  canAccessContentType,
  maskDeniedFields,
  NotFoundError,
} from '@commerceworker/domain';
import { recordAgentRun } from './agent-audit';
import { type AppContext, withActor } from './context';
import { updateEntry } from './entries';

/** Default watcher wait for a human decision before it stands down: 7 days. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Merges proposed values into the entry's current fields and saves a new
 * draft version (validated by the core) — the single apply implementation
 * shared by the agent activities and the decision use-case. Returns false
 * when the entry no longer exists.
 */
export async function applyProposedFields(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  proposed: EntryFields,
): Promise<boolean> {
  const found = await ctx.store.entries.get(scope, entryId);
  if (!found) return false;
  const merged: EntryFields = { ...found.fields };
  for (const [apiId, localized] of Object.entries(proposed)) {
    merged[apiId] = { ...(merged[apiId] ?? {}), ...localized };
  }
  await updateEntry(ctx, scope, entryId, merged);
  return true;
}

export interface CreateAgentReviewInput {
  readonly workflow: string;
  readonly entryId: string;
  readonly proposed: EntryFields;
  readonly notes: readonly string[];
}

/** Persists an agent proposal for human review (called by agent activities). */
export async function createAgentReview(
  ctx: AppContext,
  scope: Scope,
  input: CreateAgentReviewInput,
): Promise<AgentReview> {
  const review: AgentReview = {
    id: ctx.ids.newId(),
    workflow: input.workflow,
    entryId: input.entryId,
    proposed: input.proposed,
    notes: input.notes,
    status: 'pending',
    awaiting: false,
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.agentReviews.create(scope, review);
  return review;
}

export async function getAgentReview(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<AgentReview> {
  const review = await ctx.store.agentReviews.get(scope, id);
  if (!review) throw new NotFoundError('AgentReview', id);
  return review;
}

/**
 * Agent proposals, newest first. For a role-bound principal (one with content grants), a review is
 * listed only when its entry still exists and the principal may read its content type, and its
 * proposed values are masked to the fields that principal may read. The entries' types are read
 * in one batch, not one lookup per review. Without a principal (agents, tests) nothing is filtered.
 */
export async function listAgentReviews(
  ctx: AppContext,
  scope: Scope,
  query: { status?: AgentReview['status']; entryId?: string; limit?: number } = {},
  principal?: Principal,
): Promise<AgentReview[]> {
  const reviews = await ctx.store.agentReviews.list(scope, query);
  if (!principal?.contentGrants || reviews.length === 0) return reviews;
  // Only each entry's type: no fields or R2 bodies, so one unreadable body can't fail the list.
  const typeOf = await ctx.store.entries.contentTypesOf(
    scope,
    reviews.map((r) => r.entryId),
  );
  return reviews.flatMap((review) => {
    const type = typeOf.get(review.entryId);
    if (!type || !canAccessContentType(principal, 'read', type)) return [];
    return [{ ...review, proposed: maskDeniedFields(principal, type, review.proposed) }];
  });
}

/**
 * Applies an approved review's proposal EXACTLY ONCE: wins the `markApplied`
 * CAS, applies, and records the ledger entry — the single owner of both the
 * apply and its record. When the apply itself throws, the marker is rolled
 * back (compensation) so the review stays re-drivable rather than falsely
 * recorded as applied. Returns false when another path already owned it.
 */
async function applyReviewOnce(
  ctx: AppContext,
  scope: Scope,
  review: AgentReview,
): Promise<boolean> {
  const at = ctx.clock.now().toISOString();
  if (!(await ctx.store.agentReviews.markApplied(scope, review.id, at))) return false;
  // The request that approved it writes as its principal; the review watcher, which has none,
  // writes as whoever decided it (or, failing that, the agent that proposed it).
  const acting =
    ctx.actor !== undefined ? ctx : withActor(ctx, review.decidedBy ?? agentActor(review.workflow));
  let applied = false;
  try {
    applied = await applyProposedFields(acting, scope, review.entryId, review.proposed);
  } catch (err) {
    await ctx.store.agentReviews.clearApplied(scope, review.id).catch(() => {});
    throw err;
  }
  await recordAgentRun(ctx, scope, {
    workflow: review.workflow,
    entryId: review.entryId,
    status: 'completed',
    decisions: [
      applied ? 'applied after review approval' : 'approved (entry gone; nothing applied)',
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  return true;
}

export interface DecideReviewDeps {
  /**
   * Delivers the decision to a waiting durable review-watcher workflow
   * (a Cloudflare Workflow event). Returns true when the
   * watcher took delivery — it then owns applying/recording. Absent or
   * failing, the use-case applies directly; the exactly-once apply marker
   * makes either path safe.
   */
  readonly signalReview?: (
    review: AgentReview,
    decision: 'approved' | 'rejected',
  ) => Promise<boolean>;
}

export interface DecideReviewResult {
  readonly review: AgentReview;
  /** True when this call applied the proposal (vs a signaled watcher). */
  readonly applied: boolean;
  /** True when a durable watcher took delivery of the decision. */
  readonly signaled: boolean;
}

/**
 * Records a human decision on a pending review. The pending→decided
 * transition is a CAS, so concurrent reviewers can't both win. On approval
 * the proposal is applied exactly once: a signaled watcher applies it inside
 * its durable run; otherwise this use-case applies directly — both paths
 * race through `markApplied`, so a delivery ambiguity can never double-apply.
 *
 * Ledger ownership: rejections are recorded here (unconditionally — the
 * watcher never records them); the apply record belongs to whichever path
 * wins the apply CAS. Re-drive: repeating an identical approval on an
 * approved-but-unapplied review (a crashed or failed earlier apply) retries
 * the apply instead of conflicting.
 */
export async function decideAgentReview(
  ctx: AppContext,
  scope: Scope,
  id: string,
  input: { approve: boolean; decidedBy?: string },
  deps: DecideReviewDeps = {},
): Promise<DecideReviewResult> {
  const review = await ctx.store.agentReviews.get(scope, id);
  if (!review) throw new NotFoundError('AgentReview', id);
  const status = input.approve ? 'approved' : 'rejected';
  const decidedAt = ctx.clock.now().toISOString();
  const won = await ctx.store.agentReviews.decide(scope, id, {
    status,
    decidedAt,
    decidedBy: input.decidedBy,
  });
  if (!won) {
    // Idempotent re-drive: an approval that decided but failed to apply
    // (crash, validation error) may be retried until the apply lands.
    if (input.approve && review.status === 'approved' && !review.appliedAt && !review.awaiting) {
      const applied = await applyReviewOnce(ctx, scope, review);
      return { review, applied, signaled: false };
    }
    throw new ConflictError('Review was already decided');
  }
  // Re-read after the CAS: a watcher may have armed between our first read
  // and the decision — signaling it avoids a week-long zombie watcher.
  const current = await ctx.store.agentReviews.get(scope, id);
  const decided: AgentReview = current ?? {
    ...review,
    status,
    decidedAt,
    decidedBy: input.decidedBy,
  };

  let signaled = false;
  if (decided.awaiting && deps.signalReview) {
    signaled = await deps.signalReview(decided, status).catch(() => false);
  }
  let applied = false;
  if (!signaled && input.approve) {
    applied = await applyReviewOnce(ctx, scope, decided);
  }
  if (!input.approve) {
    // Rejections are side-effect-free: decide owns their single ledger record.
    await recordAgentRun(ctx, scope, {
      workflow: review.workflow,
      entryId: review.entryId,
      status: 'rejected',
      decisions: ['rejected by reviewer'],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  }
  return { review: decided, applied, signaled };
}

/**
 * Watcher-side settlement, invoked from the review workflow's activities.
 *
 * Timeout is NOT taken at face value: a decision can land while the watcher
 * is standing down (the signal/event is delivered successfully to a workflow
 * already past its wait, and the decider — seeing delivery succeed — skips
 * the direct path). Settlement therefore re-reads the review after clearing
 * `awaiting` and settles as the actual decision, closing that lost-approval
 * window. Approvals apply exactly once via {@link applyReviewOnce} (which
 * also owns the ledger record); rejections are never recorded here — the
 * decide use-case owns that record.
 */
export async function settleReviewOutcome(
  ctx: AppContext,
  scope: Scope,
  reviewId: string,
  outcome: 'approved' | 'rejected' | 'timeout',
): Promise<void> {
  await ctx.store.agentReviews.clearAwaiting(scope, reviewId);
  const review = await ctx.store.agentReviews.get(scope, reviewId);
  if (!review) return;
  const effective = outcome === 'timeout' ? review.status : outcome;
  if (effective === 'approved') {
    await applyReviewOnce(ctx, scope, review);
  }
  // 'rejected' → decide already recorded it; 'pending' → genuinely timed out.
}
