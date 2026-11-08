import {
  cancelWorkflowRun,
  createWorkflowDraft,
  decideWorkflowTask,
  deliverWorkflowEvent,
  draftWorkflowGraph,
  getWorkflowRun,
  getWorkflowRunTimeline,
  getWorkflowSettings,
  getWorkflowVersion,
  listWorkflowNodeRuns,
  listWorkflowRuns,
  listWorkflows,
  listWorkflowTasks,
  listWorkflowVersions,
  publishWorkflowVersion,
  saveWorkflowDraft,
  setWorkflowSeparationDefault,
  startWorkflowRun,
  validateWorkflowGraph,
  workflowRunView,
} from '@commerceworker/application';
import {
  describeDiff,
  principalActorId,
  SCOPES,
  ValidationError,
  WORKFLOW_RUN_STATUSES,
  type WorkflowRunStatus,
} from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { requireWorkflowEngine } from '../../api/routes/workflows';
import { ok, READ_ONLY, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerWorkflowTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, ai, principal, guard } = t;
  // --- editorial workflows (graphs, versions, runs, tasks) -----------------
  // Same use-cases and scope checks as the HTTP routes in api/routes/workflows.ts.
  const workflowEngine = () => requireWorkflowEngine(deps.workflowEngine);

  server.registerTool(
    'workflow_list',
    {
      description:
        'List the editorial workflows: each with its draft graph and latestVersion, plus how its ' +
        'latest PUBLISHED version starts (publishedTrigger: { type, label }) and startsAlongside, ' +
        'the ids of the other published workflows that start on the same trigger for an ' +
        'overlapping content type (each of them starts too; for trigger.manual the editor ' +
        'chooses). Both are null for a workflow never published.',
      inputSchema: toolSchema('workflow_list', () => z.object(scopeArgs)),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listWorkflows(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'workflow_save_draft',
    {
      description:
        'Create or update an editorial workflow draft (a graph of trigger, content, AI and ' +
        'control nodes). Without workflowId it creates a new unpublished workflow (name ' +
        'required); with it, omitted fields keep their value. Drafts may be incomplete: the ' +
        'answer carries the validation issues. Never affects published versions or runs; ' +
        'publish with workflow_publish.',
      inputSchema: toolSchema('workflow_save_draft', () =>
        z.object({
          workflowId: z.string().optional().describe('omit to create a new workflow'),
          name: z.string().max(256).optional(),
          description: z.string().max(2000).optional(),
          contentTypes: z
            .array(z.string())
            .max(100)
            .optional()
            .describe('content type apiIds the workflow covers; empty means all'),
          graph: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('{ nodes: [...], edges: [...] } in the editor’s (React Flow) shape'),
          gatesPublish: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentManage, s);
      const fields = {
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.contentTypes !== undefined ? { contentTypes: args.contentTypes } : {}),
        ...(args.graph !== undefined ? { graph: args.graph } : {}),
        ...(args.gatesPublish !== undefined ? { gatesPublish: args.gatesPublish } : {}),
      };
      if (!args.workflowId) {
        if (!args.name) {
          throw new ValidationError([{ field: 'name', message: 'required to create a workflow' }]);
        }
        return ok(await createWorkflowDraft(ctx, s, { name: args.name, ...fields }));
      }
      return ok(
        await saveWorkflowDraft(ctx, s, args.workflowId, {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...fields,
        }),
      );
    },
  );

  server.registerTool(
    'workflow_publish',
    {
      description:
        'Publish a workflow’s current draft as its next immutable version; new runs pin it, ' +
        'running runs keep theirs. Refused while the graph has validation errors.',
      inputSchema: toolSchema('workflow_publish', () =>
        z.object({ workflowId: z.string(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentManage, s);
      return ok(
        await publishWorkflowVersion(ctx, s, args.workflowId, {
          publishedBy: principalActorId(principal),
        }),
      );
    },
  );

  server.registerTool(
    'workflow_versions',
    {
      description:
        'List a workflow’s published versions (newest first), or get one with its graph when ' +
        '`version` is given.',
      inputSchema: toolSchema('workflow_versions', () =>
        z.object({
          workflowId: z.string(),
          version: z.number().int().positive().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.previewRead, s);
      return ok(
        args.version !== undefined
          ? await getWorkflowVersion(ctx, s, args.workflowId, args.version)
          : await listWorkflowVersions(ctx, s, args.workflowId),
      );
    },
  );

  server.registerTool(
    'workflow_validate',
    {
      description:
        'Validate a workflow graph with the checks the editor and publishing use. Saves ' +
        'nothing; answers { ok, errors, warnings }.',
      inputSchema: toolSchema('workflow_validate', () =>
        z.object({ graph: z.record(z.string(), z.unknown()), ...scopeArgs }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(validateWorkflowGraph(args.graph));
    },
  );

  server.registerTool(
    'workflow_copilot',
    {
      description:
        'Draft a workflow graph from a plain-language prompt, or edit `graph` when given. ' +
        'Read-only: it returns a proposal (graph, explanation, validation issues, changes and ' +
        'a one-line summary) and never saves; save it with workflow_save_draft.',
      inputSchema: toolSchema('workflow_copilot', () =>
        z.object({
          prompt: z.string().min(1).max(4000),
          graph: z.record(z.string(), z.unknown()).optional(),
          contentTypes: z.array(z.string()).max(20).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentManage, s);
      const result = await draftWorkflowGraph(ctx, ai, s, {
        prompt: args.prompt,
        ...(args.graph !== undefined ? { graph: args.graph } : {}),
        ...(args.contentTypes ? { contentTypes: args.contentTypes } : {}),
      });
      return ok({ ...result, summary: describeDiff(result.changes) });
    },
  );

  server.registerTool(
    'workflow_run_start',
    {
      description:
        'Start a run of a published workflow (trigger.manual) on an entry, e.g. "submit for ' +
        'review". The run acts as you: you need content:write on the entry’s type. One active ' +
        'run per workflow and entry.',
      inputSchema: toolSchema('workflow_run_start', () =>
        z.object({
          entryId: z.string(),
          workflowId: z.string(),
          version: z.number().int().positive().optional().describe('default: latest'),
          input: z.record(z.string(), z.unknown()).optional(),
          vars: z.record(z.string(), z.unknown()).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentWrite, s);
      const run = await startWorkflowRun(ctx, workflowEngine(), principal, s, {
        entryId: args.entryId,
        workflowId: args.workflowId,
        ...(args.version !== undefined ? { version: args.version } : {}),
        ...(args.input ? { input: args.input } : {}),
        ...(args.vars ? { vars: args.vars } : {}),
      });
      return ok(workflowRunView(run));
    },
  );

  server.registerTool(
    'workflow_run_list',
    {
      description:
        'List workflow runs, newest first, filtered by entry, workflow or status (e.g. ' +
        '"running", "waiting").',
      inputSchema: toolSchema('workflow_run_list', () =>
        z.object({
          entryId: z.string().optional(),
          workflowId: z.string().optional(),
          status: z.enum(WORKFLOW_RUN_STATUSES as unknown as [string, ...string[]]).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.previewRead, s);
      const runs = await listWorkflowRuns(
        ctx,
        s,
        {
          entryId: args.entryId,
          workflowId: args.workflowId,
          status: args.status as WorkflowRunStatus | undefined,
          limit: args.limit,
        },
        principal,
      );
      return ok(runs.map(workflowRunView));
    },
  );

  server.registerTool(
    'workflow_run_get',
    {
      description:
        'Get a workflow run: status, plan, per-node detail and what it waits on. `include` adds ' +
        'its timeline and/or finished node runs.',
      inputSchema: toolSchema('workflow_run_get', () =>
        z.object({
          runId: z.string(),
          include: z.array(z.enum(['timeline', 'nodeRuns'])).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.previewRead, s);
      const run = workflowRunView(await getWorkflowRun(ctx, s, args.runId, principal));
      const include = new Set(args.include ?? []);
      return ok({
        run,
        ...(include.has('timeline')
          ? { timeline: await getWorkflowRunTimeline(ctx, s, args.runId, principal) }
          : {}),
        ...(include.has('nodeRuns')
          ? { nodeRuns: await listWorkflowNodeRuns(ctx, s, args.runId, principal) }
          : {}),
      });
    },
  );

  server.registerTool(
    'workflow_run_cancel',
    {
      description:
        'Cancel a workflow run: stops it, undoes its finished compensable steps (newest first), ' +
        'closes its open tasks and ends it cancelled. Does nothing to a finished run.',
      inputSchema: toolSchema('workflow_run_cancel', () =>
        z.object({ runId: z.string(), reason: z.string().max(500).optional(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentWrite, s);
      return ok(
        await cancelWorkflowRun(
          ctx,
          workflowEngine(),
          principal,
          s,
          args.runId,
          args.reason !== undefined ? { reason: args.reason } : {},
          deps.workflowNodes ?? { ai },
        ),
      );
    },
  );

  server.registerTool(
    'workflow_event_deliver',
    {
      description:
        'Deliver a business event (e.g. "legal.cleared") to the run node waiting for it. An ' +
        'event nothing waits for yet is held for the first wait that opens (buffered: true).',
      inputSchema: toolSchema('workflow_event_deliver', () =>
        z.object({
          runId: z.string(),
          event: z.string().min(1).max(100),
          payload: z.record(z.string(), z.unknown()).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.contentWrite, s);
      return ok(
        await deliverWorkflowEvent(ctx, workflowEngine(), principal, s, {
          runId: args.runId,
          event: args.event,
          ...(args.payload ? { payload: args.payload } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'workflow_task_list',
    {
      description:
        'List workflow tasks: approvals, event waits and agent reviews that runs hold open. ' +
        'Filter by status (e.g. "pending"), run, entry or kind.',
      inputSchema: toolSchema('workflow_task_list', () =>
        z.object({
          status: z
            .enum([
              'pending',
              'approved',
              'rejected',
              'escalated',
              'received',
              'timeout',
              'applied',
              'cancelled',
            ])
            .optional(),
          runId: z.string().optional(),
          entryId: z.string().optional(),
          kind: z.enum(['approval', 'event', 'review']).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.previewRead, s);
      return ok(
        await listWorkflowTasks(
          ctx,
          s,
          {
            status: args.status,
            runId: args.runId,
            entryId: args.entryId,
            kind: args.kind,
            limit: args.limit,
          },
          principal,
        ),
      );
    },
  );

  server.registerTool(
    'workflow_task_decide',
    {
      description:
        'Approve or reject a workflow approval (or an agent review a run waits on). You need ' +
        'the task’s requiredScope and content-type grant; with separation of duties the run’s ' +
        'starter can’t decide, and an API token can’t decide at all.',
      inputSchema: toolSchema('workflow_task_decide', () =>
        z.object({
          taskId: z.string(),
          decision: z.enum(['approved', 'rejected']),
          note: z.string().max(2000).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const s = scopeOf(args);
      // The use-case checks the task's own scope (workflow:approve by default).
      guard(SCOPES.previewRead, s);
      return ok(
        await decideWorkflowTask(ctx, workflowEngine(), principal, s, {
          taskId: args.taskId,
          decision: args.decision,
          ...(args.note !== undefined ? { note: args.note } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'workflow_settings_set',
    {
      description:
        'Set the space’s workflow settings. separateDuties is the default for approvals whose ' +
        'node leaves it unset (applies to approvals opened from then on). Needs space:admin.',
      inputSchema: toolSchema('workflow_settings_set', () =>
        z.object({ separateDuties: z.boolean(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.spaceAdmin, s);
      await setWorkflowSeparationDefault(ctx, principal, s, args.separateDuties);
      return ok(await getWorkflowSettings(ctx, s));
    },
  );
}
