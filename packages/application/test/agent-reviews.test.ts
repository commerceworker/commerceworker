import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createAgentReview,
  createContentType,
  createEntry,
  createSpace,
  decideAgentReview,
  listAgentReviews,
  SYSTEM_CALLER,
  settleReviewOutcome,
} from '../src/index';

const scope = { spaceId: 'hitl', environmentId: 'main' };

describe('agent reviews (HITL)', () => {
  let ctx: AppContext;
  let entryId: string;

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('r'),
    };
    await createSpace(ctx, { spaceId: 'hitl', name: 'HITL', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'summary',
          name: 'Summary',
          type: 'Text',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Hello' } },
    });
    entryId = created.entry.id;
  });

  // Seeds a pending review the way the agent activities do (createAgentReview
  // is the same use-case the workflows call through Activities.createReview).
  async function proposeReview() {
    const review = await createAgentReview(ctx, scope, {
      workflow: 'enrich',
      entryId,
      proposed: { summary: { 'en-US': 'Proposed summary.' } },
      notes: ['proposed summary', 'autoApply disabled'],
    });
    return { reviewId: review.id };
  }

  it('a non-autoApply run persists its proposal as a pending review', async () => {
    const result = await proposeReview();
    expect(result.reviewId).toBeTruthy();

    const [review] = await listAgentReviews(ctx, scope, { status: 'pending' });
    expect(review?.id).toBe(result.reviewId);
    expect(review?.entryId).toBe(entryId);
    expect(review?.proposed.summary?.['en-US']).toBe('Proposed summary.');
    expect(review?.notes.length).toBeGreaterThan(0);
    // Nothing applied yet.
    const entry = await ctx.store.entries.get(scope, entryId);
    expect(entry?.fields.summary).toBeUndefined();
  });

  it('approve applies the proposal exactly once and records the run', async () => {
    const run = await proposeReview();
    const result = await decideAgentReview(ctx, scope, run.reviewId as string, {
      approve: true,
      decidedBy: 'reviewer@example.com',
    });
    expect(result.applied).toBe(true);
    expect(result.signaled).toBe(false);
    expect(result.review.status).toBe('approved');
    expect(result.review.decidedBy).toBe('reviewer@example.com');

    const entry = await ctx.store.entries.get(scope, entryId);
    expect(entry?.fields.summary?.['en-US']).toBe('Proposed summary.');
    const versionsBefore = (await ctx.store.entries.listVersions(scope, entryId)).length;

    // A late watcher settlement must not apply a second time.
    await settleReviewOutcome(ctx, scope, run.reviewId as string, 'approved');
    expect((await ctx.store.entries.listVersions(scope, entryId)).length).toBe(versionsBefore);

    const runs = await ctx.store.agentRuns.list(scope, {});
    expect(runs.some((r) => r.decisions.includes('applied after review approval'))).toBe(true);
  });

  it('reject applies nothing; a second decision conflicts', async () => {
    const run = await proposeReview();
    const result = await decideAgentReview(ctx, scope, run.reviewId as string, { approve: false });
    expect(result.applied).toBe(false);
    expect(result.review.status).toBe('rejected');
    const entry = await ctx.store.entries.get(scope, entryId);
    expect(entry?.fields.summary).toBeUndefined();

    await expect(
      decideAgentReview(ctx, scope, run.reviewId as string, { approve: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a signaled watcher owns the apply: decide does not apply directly', async () => {
    const run = await proposeReview();
    // Simulate an armed durable watcher.
    expect(await ctx.store.agentReviews.markAwaiting(scope, run.reviewId as string)).toBe('armed');

    const result = await decideAgentReview(
      ctx,
      scope,
      run.reviewId as string,
      { approve: true },
      { signalReview: async () => true },
    );
    expect(result.signaled).toBe(true);
    expect(result.applied).toBe(false);
    // Nothing applied yet — the watcher will settle it.
    let entry = await ctx.store.entries.get(scope, entryId);
    expect(entry?.fields.summary).toBeUndefined();

    // The watcher settles: applies exactly once.
    await settleReviewOutcome(ctx, scope, run.reviewId as string, 'approved');
    entry = await ctx.store.entries.get(scope, entryId);
    expect(entry?.fields.summary?.['en-US']).toBe('Proposed summary.');
  });

  it('a failed signal falls back to direct apply (never lost)', async () => {
    const run = await proposeReview();
    await ctx.store.agentReviews.markAwaiting(scope, run.reviewId as string);
    const result = await decideAgentReview(
      ctx,
      scope,
      run.reviewId as string,
      { approve: true },
      { signalReview: async () => Promise.reject(new Error('watcher gone')) },
    );
    expect(result.signaled).toBe(false);
    expect(result.applied).toBe(true);
    const entry = await ctx.store.entries.get(scope, entryId);
    expect(entry?.fields.summary?.['en-US']).toBe('Proposed summary.');
  });

  it('recovers a decision signaled into a watcher that was timing out (lost-approval window)', async () => {
    const run = await proposeReview();
    await ctx.store.agentReviews.markAwaiting(scope, run.reviewId as string);
    // The signal "succeeds" (delivered to a workflow already past its wait),
    // so decide applies nothing…
    const decision = await decideAgentReview(
      ctx,
      scope,
      run.reviewId as string,
      { approve: true },
      { signalReview: async () => true },
    );
    expect(decision.applied).toBe(false);
    // …and the watcher settles as TIMEOUT (it never observed the signal).
    // Settlement must re-check the decision and apply — nothing may be lost.
    await settleReviewOutcome(ctx, scope, run.reviewId as string, 'timeout');
    const entry = await ctx.store.entries.get(scope, entryId);
    expect(entry?.fields.summary?.['en-US']).toBe('Proposed summary.');
    const review = await ctx.store.agentReviews.get(scope, run.reviewId as string);
    expect(review?.appliedAt).toBeTruthy();
    const runs = await ctx.store.agentRuns.list(scope, {});
    expect(runs.filter((r) => r.decisions.includes('applied after review approval'))).toHaveLength(
      1,
    );
  });

  it('rejections are recorded exactly once across decide + late settlement', async () => {
    const run = await proposeReview();
    await decideAgentReview(ctx, scope, run.reviewId as string, { approve: false });
    // A late watcher settles after the rejection (decided-before-arm shape).
    await settleReviewOutcome(ctx, scope, run.reviewId as string, 'rejected');
    await settleReviewOutcome(ctx, scope, run.reviewId as string, 'timeout');
    const runs = await ctx.store.agentRuns.list(scope, {});
    expect(runs.filter((r) => r.decisions.includes('rejected by reviewer'))).toHaveLength(1);
  });

  it('a failed apply rolls the marker back and stays re-drivable', async () => {
    const review = await createAgentReview(ctx, scope, {
      workflow: 'enrich',
      entryId,
      // Symbol/Text fields must be strings — a number fails core validation.
      proposed: { summary: { 'en-US': 42 as unknown as string } },
      notes: ['bad proposal'],
    });
    await expect(decideAgentReview(ctx, scope, review.id, { approve: true })).rejects.toThrow();
    const after = await ctx.store.agentReviews.get(scope, review.id);
    expect(after?.status).toBe('approved');
    expect(after?.appliedAt).toBeUndefined(); // compensation rolled it back
  });

  it('re-drives an approved-but-unapplied review instead of conflicting', async () => {
    const run = await proposeReview();
    // Simulate a decide that CAS'd approved but crashed before applying.
    await ctx.store.agentReviews.decide(scope, run.reviewId as string, {
      status: 'approved',
      decidedAt: ctx.clock.now().toISOString(),
    });
    const result = await decideAgentReview(ctx, scope, run.reviewId as string, { approve: true });
    expect(result.applied).toBe(true);
    const entry = await ctx.store.entries.get(scope, entryId);
    expect(entry?.fields.summary?.['en-US']).toBe('Proposed summary.');
    // A mismatched re-drive still conflicts.
    await expect(
      decideAgentReview(ctx, scope, run.reviewId as string, { approve: false }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('scopes are isolated: space B cannot see or decide space A reviews', async () => {
    const other = { spaceId: 'other', environmentId: 'main' };
    await createSpace(ctx, { spaceId: 'other', name: 'Other', defaultLocale: 'en-US' });
    const run = await proposeReview();
    expect(await listAgentReviews(ctx, other, {})).toHaveLength(0);
    await expect(
      decideAgentReview(ctx, other, run.reviewId as string, { approve: true }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
