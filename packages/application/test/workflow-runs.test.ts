import {
  ForbiddenError,
  InvalidStateError,
  initPlan,
  type Principal,
  SCOPES,
  ValidationError,
  WorkflowBuilder,
} from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  RecordingWorkflowEngine,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  cancelWorkflowRun,
  closeWorkflowTask,
  createContentType,
  createEntry,
  createSpace,
  decideWorkflowTask,
  deliverWorkflowEvent,
  getWorkflowRunTimeline,
  listWorkflowTasks,
  openWorkflowTask,
  publishEntry,
  reportRun,
  SeparationOfDutiesError,
  SYSTEM_CALLER,
  setWorkflowSeparationDefault,
  startWorkflowRun,
  WORKFLOW_COMPENSATIONS,
} from '../src/index';

const scope = { spaceId: 'blog', environmentId: 'main' };
const editor: Principal = {
  spaceId: 'blog',
  kind: 'user',
  subject: 'editor@example.com',
  scopes: [SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.previewRead],
};
const writer: Principal = {
  spaceId: 'blog',
  kind: 'user',
  subject: 'writer@example.com',
  scopes: [SCOPES.contentWrite, SCOPES.previewRead],
};
/** Holds content:publish, but its role only grants `page`, not `post`. */
const pageEditor: Principal = {
  ...editor,
  subject: 'pages@example.com',
  contentGrants: [{ contentTypeApiId: 'page', actions: ['read', 'write', 'publish'] }],
};
const otherSpace: Principal = { ...editor, spaceId: 'other', subject: 'x@example.com' };

const graph = new WorkflowBuilder()
  .n('start', 'trigger.manual', 'Submit')
  .n('review', 'control.approval', 'Review', { separateDuties: true })
  .n('done', 'control.end', 'Done')
  .e('start', 'review')
  .e('review.approved', 'done')
  .e('review.rejected', 'done')
  .e('review.escalated', 'done')
  .graph();

describe('workflow runs', () => {
  let ctx: AppContext;
  let clock: FixedClock;
  let engine: RecordingWorkflowEngine;
  let entryId: string;
  let workflowId: string;

  beforeEach(async () => {
    clock = new FixedClock(new Date('2026-03-02T10:00:00.000Z'));
    ctx = { store: new InMemoryContentStore(), clock, ids: new SequenceIdGenerator('id') };
    engine = new RecordingWorkflowEngine();
    await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
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
      ],
    });
    entryId = (
      await createEntry(ctx, scope, {
        contentTypeApiId: 'post',
        fields: { title: { 'en-US': 'Hi' } },
      })
    ).entry.id;
    workflowId = 'wf-1';
    await ctx.store.workflowGraphs.publishVersion(
      scope,
      { id: workflowId, name: 'Review', description: '', contentTypes: ['post'], graph },
      { publishedAt: clock.now().toISOString() },
    );
  });

  const start = (p: Principal = writer) =>
    startWorkflowRun(ctx, engine, p, scope, { entryId, workflowId });

  const openApproval = async (runId: string, separateDuties: boolean | undefined = true) => {
    const since = clock.now().getTime();
    const { task } = await openWorkflowTask(ctx, scope, runId, {
      nodeId: 'review',
      eventType: 'approval-review-1',
      kind: 'approval',
      title: 'Review “Hi”',
      requiredScope: SCOPES.contentPublish,
      ...(separateDuties === undefined ? {} : { separateDuties }),
      since,
      deadline: since + 2 * 86_400_000,
    });
    return task;
  };

  it('starts a run pinned to the latest version, acting as its starter', async () => {
    const run = await start();
    expect(run).toMatchObject({
      status: 'queued',
      version: 1,
      generation: 1,
      instanceId: run.id,
      startedBy: { id: 'writer@example.com' },
    });
    expect(engine.started).toEqual([
      {
        instanceId: run.id,
        params: expect.objectContaining({ runId: run.id, version: 1, entryId }),
      },
    ]);
    // One active run per workflow and entry.
    await expect(start()).rejects.toThrow(/already has an active run/);
  });

  it('refuses to start without content:write, outside the space, or for an ungranted type', async () => {
    const reader: Principal = { ...writer, scopes: [SCOPES.previewRead] };
    await expect(start(reader)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(start(otherSpace)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(start(pageEditor)).rejects.toThrow(/content:write:post/);
    expect(engine.started).toHaveLength(0);
  });

  it('drops stale plan snapshots and freezes the status once terminal', async () => {
    const run = await start();
    const plan = initPlan(graph);
    await reportRun(ctx, scope, run.id, { seq: 2, status: 'running', plan, vars: { a: 2 } });
    // An older snapshot (a replayed report) changes nothing.
    await reportRun(ctx, scope, run.id, { seq: 1, status: 'waiting', vars: { a: 1 } });
    let stored = await ctx.store.workflowRuns.get(scope, run.id);
    expect(stored).toMatchObject({ seq: 2, status: 'running', vars: { a: 2 } });

    await reportRun(ctx, scope, run.id, { seq: 3, status: 'completed', reason: 'ok' });
    await reportRun(ctx, scope, run.id, { seq: 4, status: 'running' });
    stored = await ctx.store.workflowRuns.get(scope, run.id);
    expect(stored).toMatchObject({ status: 'completed', reason: 'ok', seq: 4 });
    const events = await ctx.store.outbox.readPending(50);
    expect(events.filter((e) => e.type === 'workflow_run.completed')).toHaveLength(1);
    // A reason is capped to one line of 200 characters.
    const run2 = await startWorkflowRun(ctx, engine, writer, scope, {
      entryId: (
        await createEntry(ctx, scope, {
          contentTypeApiId: 'post',
          fields: { title: { 'en-US': 'B' } },
        })
      ).entry.id,
      workflowId,
    });
    await reportRun(ctx, scope, run2.id, { status: 'failed', reason: `x\n${'word '.repeat(80)}` });
    expect((await ctx.store.workflowRuns.get(scope, run2.id))?.reason?.length).toBeLessThanOrEqual(
      200,
    );
  });

  it('records a node run on its first end only and dedupes keyed timeline entries', async () => {
    const run = await start();
    const t0 = clock.now().getTime();
    await reportRun(ctx, scope, run.id, { node: { id: 'review', runs: 1, startedAt: t0 } });
    // A retried attempt keeps the first start.
    await reportRun(ctx, scope, run.id, { node: { id: 'review', startedAt: t0 + 5 } });
    const end = { id: 'review', type: 'control.approval', summary: 'ok', endedAt: t0 + 10 };
    await reportRun(ctx, scope, run.id, {
      node: end,
      log: { at: t0, kind: 'node', message: 'Review: ok', key: 'review#1' },
    });
    await reportRun(ctx, scope, run.id, {
      node: end,
      log: { at: t0, kind: 'node', message: 'Review: ok', key: 'review#1' },
    });
    const nodeRuns = await ctx.store.workflowRuns.listNodeRuns(scope, run.id);
    expect(nodeRuns).toEqual([
      expect.objectContaining({
        nodeId: 'review',
        run: 1,
        startedAt: t0,
        endedAt: t0 + 10,
        durationMs: 10,
      }),
    ]);
    const timeline = await getWorkflowRunTimeline(ctx, scope, run.id);
    expect(timeline.filter((t) => t.key === 'review#1')).toHaveLength(1);
  });

  it('opens and closes tasks once, tracking what the run waits on', async () => {
    const run = await start();
    await openApproval(run.id);
    await openApproval(run.id);
    expect(await listWorkflowTasks(ctx, scope, { runId: run.id })).toHaveLength(1);
    expect((await ctx.store.workflowRuns.get(scope, run.id))?.waitingOn).toBe('Review “Hi”');
    await closeWorkflowTask(ctx, scope, run.id, 'approval-review-1', 'approved', {
      by: 'editor@example.com',
    });
    expect((await ctx.store.workflowRuns.get(scope, run.id))?.waitingOn).toBeNull();
    const timeline = (await getWorkflowRunTimeline(ctx, scope, run.id)).map((t) => t.message);
    expect(timeline).toContain('Awaiting approval: Review “Hi”');
    expect(timeline).toContain('Review “Hi”: approved by editor@example.com');
  });

  it('decides: scope, content grant, separation of duties, then the event', async () => {
    const run = await start();
    const task = await openApproval(run.id);
    const decide = (p: Principal) =>
      decideWorkflowTask(ctx, engine, p, scope, { taskId: task.id, decision: 'approved' });

    // content:write alone can't decide a content:publish approval.
    await expect(decide({ ...writer, subject: 'w2@example.com' })).rejects.toThrow(
      /content:publish/,
    );
    await expect(decide(otherSpace)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decide(pageEditor)).rejects.toThrow(/content:publish:post/);
    // The starter (holding the scope) still can't decide their own run.
    await expect(decide({ ...editor, subject: 'writer@example.com' })).rejects.toBeInstanceOf(
      SeparationOfDutiesError,
    );
    expect(engine.events).toHaveLength(0);

    const result = await decide(editor);
    expect(result).toMatchObject({ decision: 'approved', by: 'editor@example.com' });
    expect(engine.events).toEqual([
      {
        instanceId: run.id,
        type: 'approval-review-1',
        payload: {
          decision: 'approved',
          by: 'editor@example.com',
          note: null,
          // A person's approval names them: the run acts as them downstream.
          actor: { id: 'editor@example.com', principal: editor },
        },
      },
    ]);
    const audit = await ctx.store.audit.list('blog', {});
    expect(audit.some((a) => a.action === 'workflow.task.approved')).toBe(true);
  });

  it('lets the Approver preset decide a workflow:approve approval without acting as them', async () => {
    const run = await start();
    const since = clock.now().getTime();
    const { task } = await openWorkflowTask(ctx, scope, run.id, {
      nodeId: 'review',
      eventType: 'approval-review-2',
      kind: 'approval',
      title: 'Review “Hi”',
      requiredScope: SCOPES.workflowApprove,
      separateDuties: true,
      since,
      deadline: since + 86_400_000,
    });
    const approver: Principal = {
      spaceId: 'blog',
      kind: 'user',
      subject: 'approver@example.com',
      scopes: [SCOPES.previewRead, SCOPES.workflowApprove],
    };
    const decide = (p: Principal) =>
      decideWorkflowTask(ctx, engine, p, scope, { taskId: task.id, decision: 'approved' });
    // A writer without either scope can't decide it.
    await expect(decide({ ...writer, subject: 'w3@example.com' })).rejects.toThrow(
      /workflow:approve/,
    );
    // A role that can't read the type can't decide it either.
    await expect(
      decide({ ...approver, contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }] }),
    ).rejects.toThrow(/content:read:post/);
    await decide(approver);
    // No `actor`: the approver can't write, so the run keeps acting as its starter.
    expect(engine.events.at(-1)?.payload).toEqual({
      decision: 'approved',
      by: 'approver@example.com',
      note: null,
    });
  });

  it('requires workflow:approve exactly for an approval that names no scope', async () => {
    const run = await start();
    const since = clock.now().getTime();
    const { task } = await openWorkflowTask(ctx, scope, run.id, {
      nodeId: 'review',
      eventType: 'approval-review-3',
      kind: 'approval',
      title: 'Review “Hi”',
      since,
      deadline: since + 86_400_000,
    });
    // No requiredScope on the node: the default, workflow:approve. content:publish alone is not it.
    await expect(
      decideWorkflowTask(ctx, engine, editor, scope, { taskId: task.id, decision: 'rejected' }),
    ).rejects.toThrow(/workflow:approve/);
    const approvingEditor = { ...editor, scopes: [...editor.scopes, SCOPES.workflowApprove] };
    await expect(
      decideWorkflowTask(ctx, engine, approvingEditor, scope, {
        taskId: task.id,
        decision: 'rejected',
      }),
    ).resolves.toMatchObject({ decision: 'rejected' });
  });

  it('refuses decisions once the deadline passed or the task is settled', async () => {
    const run = await start();
    const task = await openApproval(run.id);
    clock.advance(3 * 86_400_000);
    await expect(
      decideWorkflowTask(ctx, engine, editor, scope, { taskId: task.id, decision: 'approved' }),
    ).rejects.toThrow(/window has closed/);
    await closeWorkflowTask(ctx, scope, run.id, task.eventType, 'escalated', {});
    await expect(
      decideWorkflowTask(ctx, engine, editor, scope, { taskId: task.id, decision: 'approved' }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('delivers events only to a matching wait, with a bounded payload', async () => {
    const run = await start();
    const since = clock.now().getTime();
    await openWorkflowTask(ctx, scope, run.id, {
      nodeId: 'legal',
      eventType: 'event-legal-1',
      kind: 'event',
      event: 'legal.cleared',
      title: 'Legal',
      since,
      deadline: since + 86_400_000,
    });
    expect(
      await deliverWorkflowEvent(ctx, engine, editor, scope, { runId: run.id, event: 'nope' }),
    ).toEqual({ delivered: false, buffered: true });
    await expect(
      deliverWorkflowEvent(ctx, engine, editor, scope, {
        runId: run.id,
        event: 'legal.cleared',
        payload: { big: 'x'.repeat(20_000) },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      deliverWorkflowEvent(ctx, engine, pageEditor, scope, {
        runId: run.id,
        event: 'legal.cleared',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await deliverWorkflowEvent(ctx, engine, editor, scope, {
        runId: run.id,
        event: 'legal.cleared',
        payload: { ok: true },
      }),
    ).toEqual({ delivered: true, nodeId: 'legal' });
    expect(engine.events[0]).toMatchObject({
      type: 'event-legal-1',
      payload: { ok: true, event: 'legal.cleared' },
    });
  });

  it('cancels: stops the instance, undoes finished steps newest first, once', async () => {
    const run = await start(editor);
    // Two finished compensable steps, as the interpreter would have recorded them.
    const published = await publishEntry(ctx, scope, entryId);
    const t = clock.now().getTime();
    await ctx.store.workflowRuns.recordNodeRun(scope, {
      runId: run.id,
      generation: 1,
      nodeId: 'tags',
      run: 1,
      nodeType: 'content.set_tags',
      status: 'succeeded',
      summary: null,
      output: { priorTagIds: [], tagIds: [] },
      error: null,
      startedAt: t,
      endedAt: t + 1,
      durationMs: 1,
    });
    await ctx.store.workflowRuns.recordNodeRun(scope, {
      runId: run.id,
      generation: 1,
      nodeId: 'publish',
      run: 1,
      nodeType: 'content.publish',
      status: 'succeeded',
      summary: null,
      output: { version: published.publishedVersion, publishedByRun: true },
      error: null,
      startedAt: t + 2,
      endedAt: t + 3,
      durationMs: 1,
    });
    await openApproval(run.id);

    const result = await cancelWorkflowRun(ctx, engine, editor, scope, run.id, {
      reason: 'Pulled',
    });
    expect(result.ok).toBe(true);
    expect(result.undone).toEqual(['Unpublished version 1', 'Tags already restored']);
    expect(engine.cancelled).toEqual([run.id]);
    expect((await ctx.store.entries.get(scope, entryId))?.entry.publishedVersion).toBeNull();
    const stored = await ctx.store.workflowRuns.get(scope, run.id);
    expect(stored).toMatchObject({ status: 'cancelled', reason: 'Pulled', waitingOn: null });
    expect((await listWorkflowTasks(ctx, scope, { runId: run.id }))[0]?.status).toBe('cancelled');
    const ends = (await ctx.store.outbox.readPending(50)).filter(
      (e) => e.type === 'workflow_run.cancelled',
    );
    expect(ends).toHaveLength(1);

    // A second cancel does nothing.
    expect(await cancelWorkflowRun(ctx, engine, editor, scope, run.id)).toEqual({
      ok: false,
      undone: [],
    });
  });

  it('compensations never undo later work by someone else', async () => {
    const published = await publishEntry(ctx, scope, entryId);
    const { updateEntry } = await import('../src/index');
    await updateEntry(ctx, scope, entryId, { title: { 'en-US': 'Edited' } });
    await publishEntry(ctx, scope, entryId);
    const message = await WORKFLOW_COMPENSATIONS['content.publish']?.({
      ctx,
      deps: {},
      scope,
      runId: 'r',
      entryId,
      nodeType: 'content.publish',
      output: { version: published.publishedVersion, publishedByRun: true },
      effectKey: 'p#1',
    });
    expect(message).toMatch(/republished since/);
    expect((await ctx.store.entries.get(scope, entryId))?.entry.publishedVersion).toBe(2);
  });

  it('refuses an API token on a separate-duties approval, explicitly', async () => {
    const run = await start();
    const task = await openApproval(run.id);
    const token: Principal = { spaceId: 'blog', kind: 'cma', scopes: editor.scopes };
    await expect(
      decideWorkflowTask(ctx, engine, token, scope, { taskId: task.id, decision: 'approved' }),
    ).rejects.toThrow(/needs a person; an API token/);
  });

  it('takes the space default for separation of duties when the node leaves it unset', async () => {
    const run = await start();
    const open = async (n: string, separateDuties?: boolean) => {
      const since = clock.now().getTime();
      return (
        await openWorkflowTask(ctx, scope, run.id, {
          nodeId: n,
          eventType: `approval-${n}-1`,
          kind: 'approval',
          title: n,
          ...(separateDuties === undefined ? {} : { separateDuties }),
          since,
          deadline: since + 1000,
        })
      ).task;
    };
    expect((await open('first')).separateDuties).toBe(false);
    await expect(setWorkflowSeparationDefault(ctx, editor, scope, true)).rejects.toThrow(
      /space:admin/,
    );
    const admin: Principal = { spaceId: '*', kind: 'admin', scopes: [SCOPES.spaceAdmin] };
    await setWorkflowSeparationDefault(ctx, admin, scope, true);
    expect((await open('second')).separateDuties).toBe(true);
    // An explicit node setting still wins over the space default.
    expect((await open('third', false)).separateDuties).toBe(false);
  });

  it('keeps index fields in step and moves updatedAt only when they change', async () => {
    const run = await start();
    const created = (await ctx.store.workflowRuns.get(scope, run.id))?.updatedAt;
    clock.advance(1000);
    await reportRun(ctx, scope, run.id, { seq: 1, vars: { a: 1 } });
    expect((await ctx.store.workflowRuns.get(scope, run.id))?.updatedAt).toBe(created);

    await reportRun(ctx, scope, run.id, { node: { id: 'review', label: 'Editor review' } });
    clock.advance(1000);
    const since = clock.now().getTime();
    await openWorkflowTask(ctx, scope, run.id, {
      nodeId: 'review',
      eventType: 'approval-review-9',
      kind: 'approval',
      title: 'Review “Hi”',
      assignee: 'editor',
      since,
      deadline: since + 86_400_000,
    });
    const waiting = await ctx.store.workflowRuns.get(scope, run.id);
    expect(waiting).toMatchObject({
      waitingOn: 'Review “Hi”',
      waitingAt: 'Editor review',
      waitingFor: 'person:editor',
      waitingSince: new Date(since).toISOString(),
      waitingDue: new Date(since + 86_400_000).toISOString(),
      updatedAt: new Date(since).toISOString(),
    });
    await reportRun(ctx, scope, run.id, {
      seq: 2,
      status: 'failed',
      reason: 'Publish: boom',
      node: { id: 'review', status: 'failed', error: 'boom' },
    });
    expect(await ctx.store.workflowRuns.get(scope, run.id)).toMatchObject({
      waitingOn: null,
      waitingAt: null,
      waitingFor: null,
      stoppedAt: 'Editor review',
      reason: 'Publish: boom',
    });
  });

  it('holds an early event and hands it to the wait that opens for it', async () => {
    const run = await start();
    expect(
      await deliverWorkflowEvent(ctx, engine, editor, scope, {
        runId: run.id,
        event: 'legal.cleared',
        payload: { ticket: 'L-1' },
      }),
    ).toEqual({ delivered: false, buffered: true });
    expect((await ctx.store.workflowRuns.get(scope, run.id))?.earlyEvents).toHaveLength(1);
    const since = clock.now().getTime();
    const opened = await openWorkflowTask(ctx, scope, run.id, {
      nodeId: 'legal',
      eventType: 'event-legal-1',
      kind: 'event',
      event: 'legal.cleared',
      title: 'Legal',
      since,
      deadline: since + 86_400_000,
    });
    expect(opened.early).toMatchObject({ ticket: 'L-1', event: 'legal.cleared' });
    expect((await ctx.store.workflowRuns.get(scope, run.id))?.earlyEvents).toEqual([]);
    expect(engine.events).toHaveLength(0);
  });

  it('records which model answered on AI node runs', async () => {
    const run = await start();
    await reportRun(ctx, scope, run.id, { node: { id: 'ai', startedAt: 1 } });
    await reportRun(ctx, scope, run.id, {
      node: {
        id: 'ai',
        type: 'ai.classify',
        output: { source: 'model', tier: 'fast' },
        endedAt: 2,
      },
    });
    expect((await ctx.store.workflowRuns.listNodeRuns(scope, run.id))[0]?.model).toBe('fast');
  });
});
