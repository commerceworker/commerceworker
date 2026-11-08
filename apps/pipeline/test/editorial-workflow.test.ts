import { env, introspectWorkflowInstance } from 'cloudflare:test';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  decideWorkflowTask,
  SYSTEM_CALLER,
  startWorkflowRun,
} from '@commerceworker/application';
import { type Principal, WorkflowBuilder } from '@commerceworker/domain';
import { CloudflareWorkflowEngine } from '@commerceworker/platform/workflows';
import {
  InMemoryContentStore,
  RecordingWorkflowEngine,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { editorialTestState } from './fixtures/editorial';

// The real Workflows engine (miniflare) running EditorialWorkflowBase: step names, the durable
// wait, the decision delivered through CloudflareWorkflowEngine.sendEvent, and the outcome.

const scope = { spaceId: 'blog', environmentId: 'main' };
const WRITER: Principal = {
  spaceId: 'blog',
  kind: 'user',
  subject: 'writer@example.com',
  scopes: ['content:write', 'preview:read'],
};
const EDITOR: Principal = {
  spaceId: 'blog',
  kind: 'user',
  subject: 'editor@example.com',
  scopes: ['content:write', 'content:publish', 'preview:read', 'workflow:approve'],
};

let seq = 0;

describe('EditorialWorkflow on Cloudflare Workflows', () => {
  let ctx: AppContext;
  let entryId: string;

  beforeEach(async () => {
    seq += 1;
    ctx = {
      store: new InMemoryContentStore(),
      clock: { now: () => new Date() },
      // Unique per test: Workflows instance ids live as long as the test worker.
      ids: new SequenceIdGenerator(`wf${seq}`),
      ai: { mode: 'mock', timeoutMs: 1000 },
    };
    editorialTestState.ctx = ctx;
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
        fields: { title: { 'en-US': 'Hello' } },
      })
    ).entry.id;
  });

  /** Publishes `graph`, creates the run row, and returns it with the instance's params. */
  async function prepare(graph: ReturnType<WorkflowBuilder['graph']>) {
    const v = await ctx.store.workflowGraphs.publishVersion(
      scope,
      { id: ctx.ids.newId(), name: 'Review', description: '', contentTypes: [], graph },
      { publishedAt: new Date().toISOString() },
    );
    // Recorded first, so the introspector can attach before the instance exists.
    const recorder = new RecordingWorkflowEngine();
    const run = await startWorkflowRun(ctx, recorder, WRITER, scope, {
      entryId,
      workflowId: v.id,
    });
    const params = recorder.started[0]?.params;
    if (!params) throw new Error('no params recorded');
    return { run, params };
  }

  it('waits durably for an approval, takes the decision as an event and completes', async () => {
    const graph = new WorkflowBuilder()
      .n('start', 'trigger.manual', 'Submit')
      .n('review', 'control.approval', 'Editor review')
      .n('publish', 'content.publish', 'Publish')
      .n('done', 'control.end', 'Done')
      .n('no', 'control.end', 'Declined', { outcome: 'declined' })
      .e('start', 'review')
      .e('review.approved', 'publish')
      .e('publish', 'done')
      .e('review.rejected', 'no')
      .graph();
    const { run, params } = await prepare(graph);
    const engine = new CloudflareWorkflowEngine(env.EDITORIAL_WF);

    await using instance = await introspectWorkflowInstance(env.EDITORIAL_WF, run.instanceId);
    await engine.start(run.instanceId, params);
    // Starting twice is idempotent.
    await engine.start(run.instanceId, params);

    const loaded = (await instance.waitForStepResult({ name: 'load-flow' })) as { version: number };
    expect(loaded.version).toBe(1);
    await instance.waitForStepResult({ name: 'review#1:open' });

    const [task] = await ctx.store.workflowTasks.list(scope, { runId: run.id });
    expect(task).toMatchObject({ kind: 'approval', status: 'pending' });
    expect((await ctx.store.workflowRuns.get(scope, run.id))?.status).toBe('waiting');

    await decideWorkflowTask(ctx, engine, EDITOR, scope, {
      taskId: task?.id as string,
      decision: 'approved',
    });
    await instance.waitForStepResult({ name: 'review#1:close' });
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toEqual({ outcome: 'completed', reason: '' });

    const after = await ctx.store.workflowRuns.get(scope, run.id);
    expect(after?.status).toBe('completed');
    expect(after?.nodes.publish?.ranBy).toBe('editor@example.com');
    expect((await ctx.store.entries.get(scope, entryId))?.entry.publishedVersion).toBe(1);
  });

  it('cancel terminates a waiting instance', async () => {
    const graph = new WorkflowBuilder()
      .n('start', 'trigger.manual', 'Submit')
      .n('legal', 'control.wait_event', 'Legal', { event: 'legal.cleared' })
      .n('ok', 'control.end', 'Done')
      .e('start', 'legal')
      .e('legal.received', 'ok')
      .graph();
    const { run, params } = await prepare(graph);
    const engine = new CloudflareWorkflowEngine(env.EDITORIAL_WF);

    await using instance = await introspectWorkflowInstance(env.EDITORIAL_WF, run.instanceId);
    await engine.start(run.instanceId, params);
    await instance.waitForStepResult({ name: 'legal#1:open' });

    await engine.cancel(run.instanceId);
    await instance.waitForStatus('terminated');
    // Cancelling a finished or missing instance is not an error.
    await engine.cancel(run.instanceId);
    await engine.cancel('no-such-instance');
  });
});
