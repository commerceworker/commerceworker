import { decideWorkflowTask, deliverWorkflowEvent } from '@commerceworker/application';
import { type Principal, SCOPES } from '@commerceworker/domain';
import { describe, expect, it } from 'vitest';
import { EDITOR, flow, makeHarness, scope, WRITER } from './graph-harness';

const DAY = 86_400_000;

describe('graph interpreter', () => {
  it('runs an approval through to publish, and replays to the same result', async () => {
    const h = await makeHarness();
    const graph = flow()
      .n('review', 'control.approval', 'Editor review', {
        title: 'Review “{{ref}}”',
        requiredScope: SCOPES.contentPublish,
      })
      .n('publish', 'content.publish', 'Publish')
      .n('done', 'control.end', 'Done')
      .n('no', 'control.end', 'Declined', { outcome: 'declined', reason: 'Not approved' })
      .e('start', 'review')
      .e('review.approved', 'publish')
      .e('publish', 'done')
      .e('review.rejected', 'no')
      .graph();
    // A writer submits; the editor's approval lets the run publish as the editor.
    const run = await h.start(graph, WRITER);

    const first = await h.drive(run.id);
    expect(first.status).toBe('waiting');
    const waiting = await h.run(run.id);
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.waitingOn).toBe('Review “Hello world”');
    const [task] = await h.tasks(run.id);
    expect(task).toMatchObject({
      kind: 'approval',
      status: 'pending',
      startedBy: 'writer@example.com',
    });

    await decideWorkflowTask(h.ctx, h.engine, EDITOR, scope, {
      taskId: task?.id as string,
      decision: 'approved',
      note: 'Looks good',
    });
    const done = await h.drive(run.id);
    expect(done).toEqual({ status: 'complete', value: { outcome: 'completed', reason: '' } });

    const after = await h.run(run.id);
    expect(after?.status).toBe('completed');
    expect(after?.waitingOn).toBeNull();
    expect(after?.nodes.publish).toMatchObject({ status: 'succeeded' });
    const entry = await h.ctx.store.entries.get(scope, h.entryId);
    expect(entry?.entry.publishedVersion).toBe(1);
    expect(after?.nodes.publish?.ranBy).toBe('editor@example.com');
    expect(after?.nodes.review?.output).not.toHaveProperty('actor');
    const publishRun = (await h.ctx.store.workflowRuns.listNodeRuns(scope, run.id)).find(
      (r) => r.nodeId === 'publish',
    );
    expect(publishRun?.ranBy).toBe('editor@example.com');
    expect((await h.timeline(run.id)).map((t) => t.message)).toContain(
      'Publish: Published version 1 · as editor@example.com',
    );
    expect((await h.tasks(run.id))[0]).toMatchObject({
      status: 'approved',
      decidedBy: 'editor@example.com',
      note: 'Looks good',
    });

    // Replay determinism: a third pass over the same instance re-executes nothing.
    const steps = h.instances.get(run.id)?.steps;
    const executed = steps?.executed.length;
    const timeline = (await h.timeline(run.id)).map((t) => t.message);
    const replay = await h.drive(run.id);
    expect(replay).toEqual(done);
    expect(steps?.executed.length).toBe(executed);
    expect((await h.timeline(run.id)).map((t) => t.message)).toEqual(timeline);
    expect((await h.run(run.id))?.status).toBe('completed');
    const outbox = await h.ctx.store.outbox.readPending(100);
    expect(outbox.filter((e) => e.type === 'workflow_run.completed')).toHaveLength(1);
    expect(outbox.filter((e) => e.type === 'workflow.task_opened')).toHaveLength(1);
  });

  it('takes the rejected branch and ends declined', async () => {
    const h = await makeHarness();
    const graph = flow()
      .n('review', 'control.approval', 'Review')
      .n('no', 'control.end', 'Declined', {
        outcome: 'declined',
        reason: 'Rejected by {{nodes.review.by}}',
      })
      .n('yes', 'control.end', 'Done')
      .e('start', 'review')
      .e('review.rejected', 'no')
      .e('review.approved', 'yes')
      .graph();
    const run = await h.start(graph, WRITER);
    await h.drive(run.id);
    const [task] = await h.tasks(run.id);
    await decideWorkflowTask(h.ctx, h.engine, EDITOR, scope, {
      taskId: task?.id as string,
      decision: 'rejected',
    });
    const out = await h.drive(run.id);
    expect(out).toEqual({
      status: 'complete',
      value: { outcome: 'declined', reason: 'Rejected by editor@example.com' },
    });
    expect((await h.run(run.id))?.status).toBe('declined');
    expect((await h.run(run.id))?.reason).toBe('Rejected by editor@example.com');
  });

  it('escalates an approval when its timeout passes (FixedClock)', async () => {
    const h = await makeHarness();
    const graph = flow()
      .n('review', 'control.approval', 'Review', { timeout: '2 days' })
      .n('late', 'control.end', 'Escalated', { outcome: 'cancelled', reason: 'Nobody decided' })
      .n('ok', 'control.end', 'Done')
      .e('start', 'review')
      .e('review.escalated', 'late')
      .e('review.approved', 'ok')
      .e('review.rejected', 'ok')
      .graph();
    const run = await h.start(graph);
    expect((await h.drive(run.id)).status).toBe('waiting');
    h.clock.advance(DAY);
    expect((await h.drive(run.id)).status).toBe('waiting');
    h.clock.advance(DAY + 1);
    const out = await h.drive(run.id);
    expect(out).toEqual({
      status: 'complete',
      value: { outcome: 'cancelled', reason: 'Nobody decided' },
    });
    expect((await h.tasks(run.id))[0]).toMatchObject({ status: 'escalated', decidedBy: 'timeout' });
    // The decision window is closed: deciding late is refused.
    await expect(
      decideWorkflowTask(h.ctx, h.engine, EDITOR, scope, {
        taskId: (await h.tasks(run.id))[0]?.id as string,
        decision: 'approved',
      }),
    ).rejects.toThrow(/already escalated/);
  });

  it('waits for a delivered event, putting its payload in vars; times out otherwise', async () => {
    const h = await makeHarness();
    const graph = flow()
      .n('legal', 'control.wait_event', 'Legal sign-off', {
        event: 'legal.cleared',
        timeout: '1 day',
      })
      .n('note', 'control.set', 'Note', {
        assign: { ticket: { var: 'vars.legal_cleared.ticket' } },
      })
      .n('ok', 'control.end', 'Done')
      .n('late', 'control.end', 'Late', { outcome: 'cancelled' })
      .e('start', 'legal')
      .e('legal.received', 'note')
      .e('note', 'ok')
      .e('legal.timeout', 'late')
      .graph();
    const run = await h.start(graph);
    await h.drive(run.id);
    expect(
      await deliverWorkflowEvent(h.ctx, h.engine, EDITOR, scope, {
        runId: run.id,
        event: 'other.event',
      }),
    ).toEqual({ delivered: false, buffered: true });
    expect(
      await deliverWorkflowEvent(h.ctx, h.engine, EDITOR, scope, {
        runId: run.id,
        event: 'legal.cleared',
        payload: { ticket: 'LEG-7' },
      }),
    ).toEqual({ delivered: true, nodeId: 'legal' });
    const out = await h.drive(run.id);
    expect(out.status).toBe('complete');
    const after = await h.run(run.id);
    expect(after?.status).toBe('completed');
    expect(after?.vars.ticket).toBe('LEG-7');
    expect(after?.nodes.note?.summary).toBe('Ticket LEG-7');

    const run2 = await h.start(graph);
    await h.drive(run2.id);
    h.clock.advance(DAY);
    expect((await h.drive(run2.id)).status).toBe('complete');
    expect((await h.run(run2.id))?.status).toBe('cancelled');
    expect((await h.tasks(run2.id))[0]?.status).toBe('timeout');
  });

  it('sleeps on control.wait until the clock passes', async () => {
    const h = await makeHarness();
    const graph = flow()
      .n('pause', 'control.wait', 'Cool off', { duration: '3 hours' })
      .n('until', 'control.wait', 'Until noon', {
        until: { '+': [{ var: 'now' }, 3_600_000] },
      })
      .n('done', 'control.end', 'Done')
      .e('start', 'pause')
      .e('pause', 'until')
      .e('until', 'done')
      .graph();
    const run = await h.start(graph);
    expect(await h.drive(run.id)).toMatchObject({ status: 'waiting', on: ['pause#1'] });
    expect((await h.run(run.id))?.status).toBe('waiting');
    h.clock.advance(3 * 3_600_000);
    expect(await h.drive(run.id)).toMatchObject({ status: 'waiting', on: ['until#1'] });
    h.clock.advance(3_600_000);
    expect((await h.drive(run.id)).status).toBe('complete');
    expect((await h.run(run.id))?.status).toBe('completed');
  });

  it('loops while its condition holds, with distinct step names per iteration', async () => {
    const h = await makeHarness();
    const graph = flow()
      .n('init', 'control.set', 'Init', { assign: { cycle: 0 } })
      .n('loop', 'control.loop', 'Repeat', { while: { '<': [{ var: 'vars.cycle' }, 3] } })
      .n('bump', 'control.set', 'Bump', { assign: { cycle: { '+': [{ var: 'vars.cycle' }, 1] } } })
      .n('done', 'control.end', 'Done', { reason: 'Cycled {{vars.cycle}} times' })
      .e('start', 'init')
      .e('init', 'loop')
      .e('loop.body', 'bump')
      .e('bump', 'loop', 'next')
      .e('loop.done', 'done')
      .graph();
    const run = await h.start(graph);
    const out = await h.drive(run.id);
    expect(out).toEqual({
      status: 'complete',
      value: { outcome: 'completed', reason: 'Cycled 3 times' },
    });
    const executed = h.instances.get(run.id)?.steps.executed ?? [];
    expect(executed.filter((s) => s.startsWith('bump#'))).toEqual(['bump#1', 'bump#2', 'bump#3']);
    expect(executed.filter((s) => s.startsWith('loop#'))).toEqual([
      'loop#1',
      'loop#2',
      'loop#3',
      'loop#4',
    ]);
    expect((await h.run(run.id))?.vars.cycle).toBe(3);
  });

  it('branches on a condition and joins (AND-join tolerating the untaken branch)', async () => {
    const h = await makeHarness();
    const graph = flow()
      .n('check', 'control.condition', 'Has title?', {
        expression: { '==': [{ var: 'entry.title' }, 'Hello world'] },
      })
      .n('a', 'control.set', 'A', { assign: { path: 'yes' } })
      .n('b', 'control.set', 'B', { assign: { path: 'no' } })
      .n('side', 'control.set', 'Side', { assign: { side: true } })
      .n('join', 'control.set', 'Join', { assign: { joined: true } })
      .n('done', 'control.end', 'Done')
      .e('start', 'check')
      .e('start', 'side')
      .e('check.true', 'a')
      .e('check.false', 'b')
      .e('a', 'join')
      .e('b', 'join')
      .e('side', 'join')
      .e('join', 'done')
      .graph();
    const run = await h.start(graph);
    expect((await h.drive(run.id)).status).toBe('complete');
    const after = await h.run(run.id);
    expect(after?.vars).toMatchObject({ path: 'yes', side: true, joined: true });
    expect(after?.nodes.b?.status).toBe('skipped');
    expect(after?.nodes.join?.status).toBe('succeeded');
    expect(after?.nodes.join?.runs).toBe(1);
  });

  it('rolls back compensable steps in reverse order on a failed end, once', async () => {
    const h = await makeHarness();
    const graph = flow()
      .n('tags', 'content.set_tags', 'Tag', { tags: ['reviewed'], mode: 'add' })
      .n('publish', 'content.publish', 'Publish')
      .n('fields', 'content.set_fields', 'Stamp', { values: { summary: 'Stamped {{ref}}' } })
      .n('fail', 'control.end', 'Fail', { outcome: 'failed', reason: 'Late veto' })
      .e('start', 'tags')
      .e('tags', 'publish')
      .e('publish', 'fields')
      .e('fields', 'fail')
      .graph();
    const run = await h.start(graph);
    const out = await h.drive(run.id);
    expect(out).toEqual({
      status: 'complete',
      value: { outcome: 'rolled_back', reason: 'Late veto' },
    });

    const rollbacks = (await h.timeline(run.id)).filter((t) => t.kind === 'rollback');
    expect(rollbacks.map((t) => t.nodeId)).toEqual(['fields', 'publish', 'tags']);
    const entry = await h.ctx.store.entries.get(scope, h.entryId);
    expect(entry?.entry.publishedVersion).toBeNull();
    expect(entry?.fields.summary).toBeUndefined();
    expect((await h.ctx.store.taxonomy.getEntryMetadata(scope, h.entryId))?.tags).toEqual([]);
    const after = await h.run(run.id);
    expect(after?.status).toBe('rolled_back');
    expect(after?.nodes.publish?.status).toBe('rolled_back');
    const nodeRuns = await h.ctx.store.workflowRuns.listNodeRuns(scope, run.id);
    expect(
      nodeRuns
        .filter((r) => r.status === 'rolled_back')
        .map((r) => r.nodeId)
        .sort(),
    ).toEqual(['fields', 'publish', 'tags']);

    // Idempotent: replaying runs no compensation again, and a direct second undo is a no-op.
    const steps = h.instances.get(run.id)?.steps;
    const before = steps?.executed.length;
    await h.drive(run.id);
    expect(steps?.executed.length).toBe(before);
    const publishRun = nodeRuns.find((r) => r.nodeId === 'publish');
    expect(
      await h.act.compensateNode({
        scope,
        runId: run.id,
        workflowId: run.workflowId,
        entryId: h.entryId,
        generation: 1,
        nodeId: 'publish',
        run: 1,
        nodeType: 'content.publish',
        output: publishRun?.output,
        effectKey: 'publish#1',
      }),
    ).toBe('Already undone');
  });

  it('fails a node its starter may not perform, without retries, and undoes earlier steps', async () => {
    const h = await makeHarness();
    const graph = flow()
      .n('tags', 'content.set_tags', 'Tag', { tags: ['ready'] })
      .n('publish', 'content.publish', 'Publish')
      .n('done', 'control.end', 'Done')
      .e('start', 'tags')
      .e('tags', 'publish')
      .e('publish', 'done')
      .graph();
    // A writer may tag but not publish: the run acts as its starter.
    const run = await h.start(graph, WRITER);
    const out = await h.drive(run.id);
    expect(out).toEqual({
      status: 'complete',
      value: {
        outcome: 'rolled_back',
        reason: 'Publish: Missing required scope "content:publish"',
      },
    });
    const executed = h.instances.get(run.id)?.steps.executed ?? [];
    expect(executed.filter((s) => s === 'publish#1')).toHaveLength(1);
    expect((await h.ctx.store.entries.get(scope, h.entryId))?.entry.publishedVersion).toBeNull();
    expect((await h.run(run.id))?.nodes.publish).toMatchObject({ status: 'failed' });
  });

  it('continues as new with generation-keyed effects', async () => {
    const h = await makeHarness();
    const graph = flow()
      .n('count', 'control.set', 'Count', {
        assign: { gen: { '+': [{ var: ['vars.gen', 0] }, 1] } },
      })
      .n('again', 'control.condition', 'Again?', { expression: { '<': [{ var: 'vars.gen' }, 2] } })
      .n('next', 'control.continue_as_new', 'Continue')
      .n('done', 'control.end', 'Done')
      .e('start', 'count')
      .e('count', 'again')
      .e('again.true', 'next')
      .e('again.false', 'done')
      .graph();
    const run = await h.start(graph);
    expect(await h.drive(run.id)).toEqual({
      status: 'complete',
      value: { outcome: 'continued', generation: 2 },
    });
    const g2 = `${run.id}-g2`;
    expect(h.instances.get(g2)?.params).toMatchObject({ generation: 2, vars: { gen: 1 } });
    expect((await h.run(run.id))?.instanceId).toBe(g2);
    expect((await h.drive(g2)).status).toBe('complete');
    const after = await h.run(run.id);
    expect(after).toMatchObject({ status: 'completed', generation: 2, vars: { gen: 2 } });
  });

  it('enrich waits for its review in the same inbox as approvals', async () => {
    const h = await makeHarness({ ai: { mode: 'live', timeoutMs: 1000 } });
    // A live-mode model answer for the empty summary field.
    const ai = {
      async generate() {
        return {
          text: '',
          object: { summary: 'A short summary' },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const { makeGraphActivities } = await import('../src/index');
    const act = makeGraphActivities({ ctx: h.ctx, engine: h.engine, nodes: { ai } });
    const graph = flow()
      .n('enrich', 'ai.enrich', 'Enrich', { awaitReview: true })
      .n('ok', 'control.end', 'Done')
      .n('no', 'control.end', 'No', { outcome: 'declined' })
      .e('start', 'enrich')
      .e('enrich.approved', 'ok')
      .e('enrich.rejected', 'no')
      .e('enrich.timeout', 'no')
      .graph();
    const run = await h.start(graph, WRITER);
    const inst = h.instances.get(run.id);
    if (!inst) throw new Error('no instance');
    const { runGraph } = await import('../src/index');
    const pass = () => inst.steps.run(() => runGraph(inst.steps, act, inst.params));
    expect((await pass()).status).toBe('waiting');
    const [task] = await h.tasks(run.id);
    expect(task).toMatchObject({ kind: 'review', requiredScope: 'content:write' });
    await decideWorkflowTask(h.ctx, h.engine, EDITOR, scope, {
      taskId: task?.id as string,
      decision: 'approved',
    });
    expect((await pass()).status).toBe('complete');
    expect((await h.run(run.id))?.status).toBe('completed');
    const entry = await h.ctx.store.entries.get(scope, h.entryId);
    expect(entry?.fields.summary?.['en-US']).toBe('A short summary');
  });

  it('takes an event delivered before its wait opened, without waiting', async () => {
    const h = await makeHarness();
    const graph = flow()
      .n('pause', 'control.wait', 'Cool off', { duration: '1 hour' })
      .n('legal', 'control.wait_event', 'Legal', { event: 'legal.cleared' })
      .n('ok', 'control.end', 'Done')
      .n('late', 'control.end', 'Late', { outcome: 'cancelled' })
      .e('start', 'pause')
      .e('pause', 'legal')
      .e('legal.received', 'ok')
      .e('legal.timeout', 'late')
      .graph();
    const run = await h.start(graph);
    expect(await h.drive(run.id)).toMatchObject({ status: 'waiting', on: ['pause#1'] });
    expect(await h.run(run.id)).toMatchObject({ waitingAt: 'Cool off', waitingFor: 'timer' });
    expect(
      await deliverWorkflowEvent(h.ctx, h.engine, EDITOR, scope, {
        runId: run.id,
        event: 'legal.cleared',
        payload: { ticket: 'L-2' },
      }),
    ).toEqual({ delivered: false, buffered: true });
    h.clock.advance(3_600_000);
    expect((await h.drive(run.id)).status).toBe('complete');
    const after = await h.run(run.id);
    expect(after?.status).toBe('completed');
    expect(after?.vars.legal_cleared).toMatchObject({ ticket: 'L-2' });
  });

  it('router guards are checked in code before the model’s choice is taken', async () => {
    const h = await makeHarness({ ai: { mode: 'live', timeoutMs: 1000 } });
    const ai = {
      async generate() {
        return {
          text: '',
          object: { route: 'publish', reason: 'Looks fine' },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const { makeGraphActivities, runGraph } = await import('../src/index');
    const act = makeGraphActivities({ ctx: h.ctx, engine: h.engine, nodes: { ai } });
    const graph = flow()
      .n('route', 'ai.router', 'Route', {
        routes: ['publish', 'needs_review'],
        guards: { publish: { in: ['trusted', { var: 'entry.tags' }] } },
      })
      .n('a', 'control.end', 'Published')
      .n('b', 'control.end', 'Review', { outcome: 'declined' })
      .e('start', 'route')
      .e('route.publish', 'a')
      .e('route.needs_review', 'b')
      .graph();
    const run = await h.start(graph);
    const inst = h.instances.get(run.id);
    if (!inst) throw new Error('no instance');
    await inst.steps.run(() => runGraph(inst.steps, act, inst.params));
    const after = await h.run(run.id);
    expect(after?.status).toBe('declined');
    expect(after?.nodes.route?.output).toMatchObject({
      route: 'needs_review',
      blocked: ['publish'],
    });
  });

  describe('who a run acts as: starter, then approver', () => {
    const OTHER_EDITOR: Principal = { ...EDITOR, subject: 'chief@example.com' };
    const TOKEN: Principal = { spaceId: 'blog', kind: 'cma', scopes: EDITOR.scopes };

    const approveFirst = async (
      h: Awaited<ReturnType<typeof makeHarness>>,
      runId: string,
      p: Principal,
    ) => {
      await h.drive(runId);
      const pending = (await h.tasks(runId)).find((t) => t.status === 'pending');
      await decideWorkflowTask(h.ctx, h.engine, p, scope, {
        taskId: pending?.id as string,
        decision: 'approved',
      });
      return h.drive(runId);
    };

    it('steps before any approval keep the starter’s rights', async () => {
      const h = await makeHarness();
      const graph = flow()
        .n('early', 'content.publish', 'Publish early')
        .n('review', 'control.approval', 'Review')
        .n('done', 'control.end', 'Done')
        .e('start', 'early')
        .e('early', 'review')
        .e('review.approved', 'done')
        .graph();
      const run = await h.start(graph, WRITER);
      const out = await h.drive(run.id);
      expect(out).toMatchObject({ status: 'complete', value: { outcome: 'failed' } });
      expect((await h.run(run.id))?.nodes.early).toMatchObject({
        status: 'failed',
        ranBy: 'writer@example.com',
      });
      expect(await h.tasks(run.id)).toHaveLength(0);
    });

    it('an approval decided by an API token keeps the starter', async () => {
      const h = await makeHarness();
      const graph = flow()
        .n('review', 'control.approval', 'Review')
        .n('publish', 'content.publish', 'Publish')
        .n('done', 'control.end', 'Done')
        .e('start', 'review')
        .e('review.approved', 'publish')
        .e('publish', 'done')
        .graph();
      const run = await h.start(graph, WRITER);
      const out = await approveFirst(h, run.id, TOKEN);
      // Still the writer, who can't publish: the run fails at publish.
      expect(out).toMatchObject({ status: 'complete', value: { outcome: 'failed' } });
      expect((await h.run(run.id))?.nodes.publish?.ranBy).toBe('writer@example.com');
      expect((await h.tasks(run.id))[0]?.decidedBy).toBe('cma');
    });

    it('chained approvals act as the most recent approver', async () => {
      const h = await makeHarness();
      const graph = flow()
        .n('first', 'control.approval', 'First look')
        .n('stamp', 'content.set_fields', 'Stamp', { values: { summary: 'Checked' } })
        .n('second', 'control.approval', 'Final say')
        .n('publish', 'content.publish', 'Publish')
        .n('done', 'control.end', 'Done')
        .e('start', 'first')
        .e('first.approved', 'stamp')
        .e('stamp', 'second')
        .e('second.approved', 'publish')
        .e('publish', 'done')
        .graph();
      const run = await h.start(graph, WRITER);
      expect((await approveFirst(h, run.id, EDITOR)).status).toBe('waiting');
      expect((await approveFirst(h, run.id, OTHER_EDITOR)).status).toBe('complete');
      const after = await h.run(run.id);
      expect(after?.status).toBe('completed');
      expect(after?.nodes.stamp?.ranBy).toBe('editor@example.com');
      expect(after?.nodes.publish?.ranBy).toBe('chief@example.com');
    });

    it('rejections don’t change identity, and an undo runs as whoever ran the step', async () => {
      const h = await makeHarness();
      const graph = flow()
        .n('review', 'control.approval', 'Review')
        .n('publish', 'content.publish', 'Publish')
        .n('veto', 'control.end', 'Veto', { outcome: 'failed', reason: 'Late veto' })
        .n('no', 'control.end', 'No', { outcome: 'declined' })
        .e('start', 'review')
        .e('review.approved', 'publish')
        .e('publish', 'veto')
        .e('review.rejected', 'no')
        .graph();
      const run = await h.start(graph, WRITER);
      const out = await approveFirst(h, run.id, EDITOR);
      expect(out).toMatchObject({ status: 'complete', value: { outcome: 'rolled_back' } });
      expect((await h.ctx.store.entries.get(scope, h.entryId))?.entry.publishedVersion).toBeNull();
      expect((await h.timeline(run.id)).map((t) => t.message)).toContain(
        'Publish: Unpublished version 1 · as editor@example.com',
      );

      const run2 = await h.start(graph, WRITER);
      await h.drive(run2.id);
      const [task] = await h.tasks(run2.id);
      await decideWorkflowTask(h.ctx, h.engine, EDITOR, scope, {
        taskId: task?.id as string,
        decision: 'rejected',
      });
      await h.drive(run2.id);
      expect((await h.run(run2.id))?.nodes.no?.ranBy).toBe('writer@example.com');
    });
  });
});
