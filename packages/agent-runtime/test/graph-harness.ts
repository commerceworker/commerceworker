import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  SYSTEM_CALLER,
  startWorkflowRun,
} from '@commerceworker/application';
import {
  type Principal,
  WorkflowBuilder,
  type WorkflowGraph,
  type WorkflowRunParams,
} from '@commerceworker/domain';
import {
  FakeWorkflowSteps,
  FixedClock,
  InMemoryContentStore,
  RecordingEmailSender,
  RecordingWebhookSender,
  RecordingWorkflowEngine,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { makeGraphActivities, runGraph } from '../src/index';

export const scope = { spaceId: 'blog', environmentId: 'main' };

export const EDITOR: Principal = {
  spaceId: 'blog',
  kind: 'user',
  subject: 'editor@example.com',
  scopes: ['content:write', 'content:publish', 'preview:read', 'delivery:read', 'workflow:approve'],
};
export const WRITER: Principal = {
  spaceId: 'blog',
  kind: 'user',
  subject: 'writer@example.com',
  scopes: ['content:write', 'preview:read'],
};

/**
 * A Cloudflare-Workflows stand-in for tests: every started instance gets its own
 * `FakeWorkflowSteps` (journal + inbox), `sendEvent` lands in that inbox, and `drive` runs one
 * pass of the interpreter over the instance — run it again and finished steps replay.
 */
export async function makeHarness(opts: { ai?: AppContext['ai'] } = {}) {
  const clock = new FixedClock(new Date('2026-03-02T10:00:00.000Z'));
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock,
    ids: new SequenceIdGenerator('id'),
    ai: opts.ai ?? { mode: 'mock', timeoutMs: 1000 },
  };
  const instances = new Map<string, { steps: FakeWorkflowSteps; params: WorkflowRunParams }>();
  const engine = new RecordingWorkflowEngine({
    onStart: async (id, params) => {
      instances.set(id, { steps: new FakeWorkflowSteps(clock), params });
    },
    onEvent: async (id, type, payload) => {
      instances.get(id)?.steps.sendEvent(type, payload);
    },
  });
  const email = new RecordingEmailSender();
  const webhooks = new RecordingWebhookSender();
  const act = makeGraphActivities({ ctx, engine, nodes: { email, webhooks } });

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
  const entry = await createEntry(ctx, scope, {
    contentTypeApiId: 'post',
    fields: { title: { 'en-US': 'Hello world' } },
  });

  const publishGraph = async (graph: WorkflowGraph, contentTypes: string[] = []) => {
    const id = ctx.ids.newId();
    const v = await ctx.store.workflowGraphs.publishVersion(
      scope,
      { id, name: 'Test flow', description: '', contentTypes, graph },
      { publishedAt: clock.now().toISOString() },
    );
    return v;
  };

  const start = async (graph: WorkflowGraph, principal: Principal = EDITOR) => {
    const v = await publishGraph(graph);
    return startWorkflowRun(ctx, engine, principal, scope, {
      entryId: entry.entry.id,
      workflowId: v.id,
    });
  };

  const drive = async (instanceId: string) => {
    const inst = instances.get(instanceId);
    if (!inst) throw new Error(`No instance ${instanceId}`);
    return inst.steps.run(() => runGraph(inst.steps, act, inst.params));
  };

  const run = (id: string) => ctx.store.workflowRuns.get(scope, id);
  const timeline = (id: string) => ctx.store.workflowRuns.listTimeline(scope, id);
  const tasks = (runId: string) => ctx.store.workflowTasks.list(scope, { runId });

  return {
    ctx,
    clock,
    engine,
    email,
    webhooks,
    act,
    instances,
    entryId: entry.entry.id,
    publishGraph,
    start,
    drive,
    run,
    timeline,
    tasks,
  };
}

export const flow = () => new WorkflowBuilder().n('start', 'trigger.manual', 'Submit');
