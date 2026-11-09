import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createAgentReview,
  createContentType,
  createEntry,
  createSpace,
  createWorkflowDraft,
  publishContentType,
  publishWorkflowVersion,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import { type Principal, SCOPES, WorkflowBuilder } from '@commerceworker/domain';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import {
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';
import { makeTestWorkflowEngine } from '../workflow-engine-harness';

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };

const ADMIN: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const WRITER: Principal = {
  spaceId: SPACE,
  kind: 'user',
  subject: 'writer@example.com',
  scopes: ['content:write', 'preview:read'],
};
const EDITOR: Principal = {
  spaceId: SPACE,
  kind: 'user',
  subject: 'editor@example.com',
  scopes: ['content:write', 'content:publish', 'preview:read', 'workflow:approve'],
};
const READER: Principal = { spaceId: SPACE, kind: 'cpa', scopes: ['preview:read'] };

type Json = Record<string, unknown>;

const reviewGraph = () =>
  new WorkflowBuilder()
    .n('start', 'trigger.manual', 'Submit')
    .n('review', 'control.approval', 'Review', { separateDuties: true })
    .n('done', 'control.end', 'Done')
    .n('no', 'control.end', 'Declined', { outcome: 'declined' })
    .e('start', 'review')
    .e('review.approved', 'done')
    .e('review.rejected', 'no')
    .graph();

describe('MCP workflow tools', () => {
  let deps: McpDeps;
  let harness: ReturnType<typeof makeTestWorkflowEngine>;
  let entryId: string;

  beforeEach(async () => {
    const ctx: AppContext = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('m'),
      ai: { mode: 'mock', timeoutMs: 1000 },
    };
    harness = makeTestWorkflowEngine(ctx);
    deps = {
      ...inMemoryEdge(),
      ctx,
      ai: new StubAIProvider(() => ({})),
      rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
      hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
      adminToken: 'admin',
      workflowEngine: harness.engine,
      agents: new InProcessAgentRuntime(
        makeActivities({ ctx, ai: new StubAIProvider(() => ({})) }),
      ),
    };
    await createSpace(ctx, { spaceId: SPACE, name: 'Blog', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'article',
      name: 'Article',
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
    await publishContentType(ctx, scope, 'article');
    entryId = (
      await createEntry(ctx, scope, {
        contentTypeApiId: 'article',
        fields: { title: { 'en-US': 'Hello' } },
      })
    ).entry.id;
  });

  async function connect(principal: Principal, d: McpDeps = deps) {
    const server = buildServer(d, principal);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return {
      client,
      call: async (name: string, args: Json = {}) => {
        const res = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
          isError?: boolean;
          content?: { type: string; text?: string }[];
        };
        const text = res.content?.find((c) => c.type === 'text')?.text ?? 'null';
        // Errors come back as `{ error }`; tests assert on whichever shape they expect.
        if (res.isError) return { error: text } as Json;
        return JSON.parse(text) as Json;
      },
    };
  }

  it('declares annotations on the workflow tools', async () => {
    const { client } = await connect(ADMIN);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of [
      'workflow_save_draft',
      'workflow_publish',
      'workflow_versions',
      'workflow_validate',
      'workflow_copilot',
      'workflow_run_start',
      'workflow_run_list',
      'workflow_run_get',
      'workflow_run_cancel',
      'workflow_event_deliver',
      'workflow_task_list',
      'workflow_task_decide',
      'workflow_settings_set',
    ]) {
      expect(byName.get(name)?.annotations, name).toBeDefined();
    }
    expect(byName.get('workflow_run_list')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('workflow_run_cancel')?.annotations?.destructiveHint).toBe(true);
  });

  it('counts what waits in Approvals, read-only, as the caller’s lists show it', async () => {
    const admin = await connect(ADMIN);
    const wf = (await admin.call('workflow_save_draft', { name: 'Review', graph: reviewGraph() }))
      .workflow as Json;
    await admin.call('workflow_publish', { workflowId: wf.id });
    const run = await (await connect(WRITER)).call('workflow_run_start', {
      entryId,
      workflowId: wf.id,
    });
    await harness.drive(run.id as string);
    await createAgentReview(deps.ctx, scope, {
      workflow: 'enrich',
      entryId,
      proposed: { title: { 'en-US': 'Better' } },
      notes: [],
    });

    const { client, call } = await connect(READER);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'approvals_count')?.annotations?.readOnlyHint).toBe(true);
    expect(await call('approvals_count')).toEqual({
      workflowTasks: 1,
      agentReviews: 1,
      total: 2,
    });

    // A role that can't read articles counts none of it, and its list agrees.
    const elsewhere = await connect({
      ...READER,
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }],
    });
    expect(await elsewhere.call('approvals_count')).toEqual({
      workflowTasks: 0,
      agentReviews: 0,
      total: 0,
    });
    expect(await elsewhere.call('agent_review_list', { status: 'pending' })).toEqual({
      items: [],
    });

    const noScope = await connect({ spaceId: SPACE, kind: 'cda', scopes: ['content:read'] });
    expect((await noScope.call('approvals_count')).error).toMatch(/preview:read/);
  });

  it('creates, publishes and versions a workflow; copilot and validate save nothing', async () => {
    const { call } = await connect(ADMIN);
    const created = await call('workflow_save_draft', { name: 'Review', graph: reviewGraph() });
    const wf = created.workflow as Json;
    expect(created.validation).toMatchObject({ ok: true });
    const saved = await call('workflow_save_draft', {
      workflowId: wf.id,
      description: 'Two eyes',
    });
    expect(saved.workflow).toMatchObject({ name: 'Review', description: 'Two eyes' });
    expect(await call('workflow_publish', { workflowId: wf.id })).toMatchObject({
      version: 1,
      publishedBy: 'admin-token',
    });
    const versions = (await call('workflow_versions', { workflowId: wf.id })) as unknown as Json[];
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(await call('workflow_versions', { workflowId: wf.id, version: 1 })).toMatchObject({
      version: 1,
    });
    expect(await call('workflow_validate', { graph: { nodes: [], edges: 3 } })).toMatchObject({
      ok: false,
    });
    const proposal = await call('workflow_copilot', { prompt: 'add an approval' });
    expect(proposal).toHaveProperty('summary');
    expect(proposal).toHaveProperty('graph');

    const missingName = await call('workflow_save_draft', {});
    expect(missingName.error).toMatch(/invalid/);
  });

  it('runs an approval end to end with separation of duties', async () => {
    const admin = await connect(ADMIN);
    const wf = (await admin.call('workflow_save_draft', { name: 'Review', graph: reviewGraph() }))
      .workflow as Json;
    await admin.call('workflow_publish', { workflowId: wf.id });

    const writer = await connect(WRITER);
    const run = await writer.call('workflow_run_start', { entryId, workflowId: wf.id });
    expect(run.startedBy).toEqual({ id: 'writer@example.com' });
    await harness.drive(run.id as string);

    const reader = await connect(READER);
    const got = await reader.call('workflow_run_get', {
      runId: run.id,
      include: ['timeline', 'nodeRuns'],
    });
    expect(got.run).toMatchObject({ status: 'waiting' });
    expect(Array.isArray(got.timeline)).toBe(true);
    expect(Array.isArray(got.nodeRuns)).toBe(true);
    expect(
      ((await reader.call('workflow_run_list', { entryId })) as unknown as Json[]).length,
    ).toBe(1);
    expect((await reader.call('workflow_run_start', { entryId, workflowId: wf.id })).error).toMatch(
      /content:write/,
    );

    const [task] = (await reader.call('workflow_task_list', {
      runId: run.id,
      status: 'pending',
    })) as unknown as Json[];
    expect(task).toMatchObject({ kind: 'approval' });

    // The starter can't approve their own run; an editor can.
    const own = await writer.call('workflow_task_decide', {
      taskId: task?.id,
      decision: 'approved',
    });
    expect(own.error).toBeDefined();
    const editor = await connect(EDITOR);
    expect(
      await editor.call('workflow_task_decide', { taskId: task?.id, decision: 'approved' }),
    ).toMatchObject({ decision: 'approved', by: 'editor@example.com' });
    expect(await harness.drive(run.id as string)).toMatchObject({ status: 'complete' });
    expect(((await reader.call('workflow_run_get', { runId: run.id })).run as Json).status).toBe(
      'completed',
    );
  });

  it('delivers events, cancels runs and sets the space default', async () => {
    const admin = await connect(ADMIN);
    const wf = (
      await admin.call('workflow_save_draft', {
        name: 'Legal',
        graph: new WorkflowBuilder()
          .n('start', 'trigger.manual', 'Submit')
          .n('legal', 'control.wait_event', 'Legal', { event: 'legal.cleared' })
          .n('ok', 'control.end', 'Done')
          .n('late', 'control.end', 'Late', { outcome: 'cancelled' })
          .e('start', 'legal')
          .e('legal.received', 'ok')
          .e('legal.timeout', 'late')
          .graph(),
      })
    ).workflow as Json;
    await admin.call('workflow_publish', { workflowId: wf.id });
    const run = await admin.call('workflow_run_start', { entryId, workflowId: wf.id });
    await harness.drive(run.id as string);
    expect(
      await admin.call('workflow_event_deliver', { runId: run.id, event: 'legal.cleared' }),
    ).toMatchObject({ delivered: true });
    expect(await harness.drive(run.id as string)).toMatchObject({ status: 'complete' });

    const second = await admin.call('workflow_run_start', { entryId, workflowId: wf.id });
    await harness.drive(second.id as string);
    expect(await admin.call('workflow_run_cancel', { runId: second.id })).toMatchObject({
      ok: true,
    });

    expect(await admin.call('workflow_settings_set', { separateDuties: true })).toEqual({
      separateDuties: true,
    });
    expect(
      (await (await connect(EDITOR)).call('workflow_settings_set', { separateDuties: false }))
        .error,
    ).toMatch(/space:admin/);
  });

  it('refuses entries_publish of a gated entry, for an admin too, while its run publishes', async () => {
    const { ctx } = deps;
    const { workflow } = await createWorkflowDraft(ctx, scope, {
      name: 'Gate',
      gatesPublish: true,
      graph: new WorkflowBuilder()
        .n('start', 'trigger.manual', 'Submit')
        .n('publish', 'content.publish', 'Publish')
        .n('done', 'control.end', 'Done')
        .e('start', 'publish')
        .e('publish', 'done')
        .graph(),
    });
    await publishWorkflowVersion(ctx, scope, workflow.id);
    const { call } = await connect(ADMIN);

    const refused = await call('entries_publish', { id: entryId });
    expect(refused.error).toContain('publishes only through a run of the workflow "Gate"');
    // A grant-shaped argument is not a grant: the publish is refused by the gate, as without it.
    const forged = await call('entries_publish', {
      id: entryId,
      grant: { kind: 'workflow_run', workflowId: workflow.id, runId: 'r' },
    });
    expect(forged.error).toContain('publishes only through a run of the workflow "Gate"');

    const run = await call('workflow_run_start', { entryId, workflowId: workflow.id });
    expect(await harness.drive(run.id as string)).toMatchObject({ status: 'complete' });
    expect((await ctx.store.entries.get(scope, entryId))?.entry.status).toBe('published');
  });

  it('refuses run actions when no workflow engine is bound', async () => {
    const { call } = await connect(ADMIN, { ...deps, workflowEngine: undefined });
    const res = await call('workflow_run_start', { entryId, workflowId: 'w' });
    expect(res.error).toMatch(/workflow engine/);
  });
});
