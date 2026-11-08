import {
  cancelWorkflowRun,
  countPendingApprovals,
  createWorkflowDraft,
  decideWorkflowTask,
  defineWorkflow,
  deliverWorkflowEvent,
  draftWorkflowGraph,
  getWorkflowRun,
  getWorkflowRunTimeline,
  getWorkflowSettings,
  getWorkflowTask,
  getWorkflowVersion,
  listWorkflowNodeRuns,
  listWorkflowRuns,
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
  NotConfiguredError,
  principalActorId,
  SCOPES,
  type Scope,
  ValidationError,
  WORKFLOW_RUN_STATUSES,
  type WorkflowRunStatus,
  type WorkflowTaskStatus,
} from '@commerceworker/domain';
import type { WorkflowEngine } from '@commerceworker/ports';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { type AuthDeps, type AuthVars, requireScope } from '../auth';
import { doc } from '../docs/openapi';
import {
  cancelWorkflowRunBody,
  createWorkflowBody,
  decideWorkflowTaskBody,
  parseBody,
  startWorkflowRunBody,
  validateWorkflowBody,
  workflowCopilotBody,
  workflowDraftBody,
  workflowEventBody,
  workflowSettingsBody,
} from '../validation';
import { actingCtx } from './management/shared';

const BASE = '/spaces/:space/environments/:env';

/** `GET …/approvals/count`'s answer, for the OpenAPI document. */
const PENDING_APPROVALS_COUNT = z.object({
  workflowTasks: z.number().int().describe('Workflow steps paused for a person'),
  agentReviews: z.number().int().describe('Agent proposals awaiting review'),
  total: z.number().int(),
});

const scopeOf = (c: Context<AuthVars>): Scope => ({
  spaceId: c.req.param('space') as string,
  environmentId: c.get('environmentId') ?? (c.req.param('env') as string),
});

export const WORKFLOW_TASK_STATUSES: readonly WorkflowTaskStatus[] = [
  'pending',
  'approved',
  'rejected',
  'escalated',
  'received',
  'timeout',
  'applied',
  'cancelled',
];
const TASK_KINDS = ['approval', 'event', 'review'] as const;

/** Parses the run/task list filters shared by the HTTP API and MCP. */
function oneOf<T extends string>(field: string, value: string | undefined, allowed: readonly T[]) {
  if (value === undefined || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError([{ field, message: `one of ${allowed.join(', ')}` }]);
  }
  return value as T;
}
function limitOf(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new ValidationError([{ field: 'limit', message: 'an integer from 1 to 200' }]);
  }
  return n;
}

/** Thrown by run actions (HTTP and MCP) when the deployment has no EDITORIAL_WF binding. */
export function requireWorkflowEngine(engine: WorkflowEngine | undefined): WorkflowEngine {
  if (engine) return engine;
  // The caller sees a generic message; the operator log names the missing binding.
  console.warn('workflows: no EDITORIAL_WF binding on this deployment; run actions refused');
  throw new NotConfiguredError(
    'workflows',
    'Workflow runs need the durable workflow engine configured on this deployment',
  );
}

/**
 * Editorial workflow routes: definitions and versions, runs, tasks (approvals and event waits),
 * the space's workflow settings and the copilot. Thin: scope guard, parse, use-case, serialize.
 * Mounted by `managementRoutes`, which installs the principal, environment and audit middleware.
 */
export function workflowRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, ai } = deps;
  const app = new Hono<AuthVars>();
  const engine = () => requireWorkflowEngine(deps.workflowEngine);

  // --- definitions and versions -------------------------------------------
  app.post(
    `${BASE}/workflows`,
    doc('Workflows', 'Create a workflow', {
      body: createWorkflowBody,
      status: 201,
      description:
        'Legacy `{name, steps}` converts the steps to a graph and publishes it as version 1 ' +
        '(the response is the workflow). A graph body `{name, description?, contentTypes?, ' +
        'graph?, gatesPublish?}` creates an unpublished draft and answers `{workflow, ' +
        'validation}`; drafts may be incomplete, only shape errors refuse.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, createWorkflowBody);
      if ('steps' in body) {
        // Step scopes are checked by the use-case (assertValidWorkflow).
        const legacy = body as Parameters<typeof defineWorkflow>[2];
        return c.json(await defineWorkflow(ctx, scopeOf(c), legacy), 201);
      }
      return c.json(await createWorkflowDraft(ctx, scopeOf(c), body), 201);
    },
  );
  app.post(
    `${BASE}/workflows/validate`,
    doc('Workflows', 'Validate a workflow graph', {
      body: validateWorkflowBody,
      description:
        'Runs the same shape and semantic checks the editor, copilot and publishing use. ' +
        'Saves nothing. Answers `{ok, errors, warnings}`.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(validateWorkflowGraph((await parseBody(c, validateWorkflowBody)).graph)),
  );
  app.post(
    `${BASE}/workflows/copilot`,
    doc('Workflows', 'Draft or edit a workflow graph with AI', {
      body: workflowCopilotBody,
      description:
        'Proposes a graph from a plain-language `prompt` (editing `graph` when given). ' +
        'Read-only: it never saves. Answers the normalized graph, an explanation, the ' +
        'validation issues, `changes` against the input and `summary` (a one-line ' +
        'description of the changes). Falls back to a heuristic when the model is ' +
        'unavailable (see `provenance`).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, workflowCopilotBody);
      const result = await draftWorkflowGraph(ctx, ai, scopeOf(c), body);
      return c.json({ ...result, summary: describeDiff(result.changes) });
    },
  );
  app.put(
    `${BASE}/workflows/:id/draft`,
    doc('Workflows', 'Save a workflow draft', {
      body: workflowDraftBody,
      description:
        'Updates the editable draft; omitted fields keep their value. Never touches published ' +
        'versions or running runs. Answers `{workflow, validation}`.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await saveWorkflowDraft(
          ctx,
          scopeOf(c),
          c.req.param('id'),
          await parseBody(c, workflowDraftBody),
        ),
      ),
  );
  app.post(
    `${BASE}/workflows/:id/versions`,
    doc('Workflows', 'Publish the draft as a new version', {
      status: 201,
      description:
        'Appends the draft as the next immutable, numbered version; new runs pin it. Refused ' +
        '(422) while validation reports errors. `publishedBy` records the caller.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await publishWorkflowVersion(ctx, scopeOf(c), c.req.param('id'), {
          publishedBy: principalActorId(c.get('principal')),
        }),
        201,
      ),
  );
  app.get(
    `${BASE}/workflows/:id/versions`,
    doc('Workflows', 'List published versions', { description: 'Newest first.' }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json({ items: await listWorkflowVersions(ctx, scopeOf(c), c.req.param('id')) }),
  );
  app.get(
    `${BASE}/workflows/:id/versions/:version`,
    doc('Workflows', 'Get one published version', {
      description: 'Versions outlive a deleted definition: runs pinned to them keep loading.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json(
        await getWorkflowVersion(
          ctx,
          scopeOf(c),
          c.req.param('id'),
          Number(c.req.param('version')),
        ),
      ),
  );

  // --- runs ------------------------------------------------------------------
  app.post(
    `${BASE}/entries/:id/workflow-runs`,
    doc('Workflows', 'Start a workflow run on an entry', {
      body: startWorkflowRunBody,
      status: 201,
      description:
        'Starts a run of a published version (the latest unless `version` is given) of a ' +
        'workflow whose trigger is `trigger.manual`. Needs `content:write` on the entry’s ' +
        'content type; the run then acts as the caller. One active run per workflow and ' +
        'entry (409). 501 when the deployment has no EDITORIAL_WF binding.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, startWorkflowRunBody);
      const run = await startWorkflowRun(ctx, engine(), c.get('principal'), scopeOf(c), {
        entryId: c.req.param('id'),
        ...body,
      });
      return c.json(workflowRunView(run), 201);
    },
  );
  app.get(
    `${BASE}/workflow-runs`,
    doc('Workflows', 'List workflow runs', {
      query: {
        entryId: 'Only runs on this entry',
        workflowId: 'Only runs of this workflow',
        status: `One of ${WORKFLOW_RUN_STATUSES.join(', ')}`,
        limit: 'Default 50, at most 200',
      },
      description: 'Runs on content types the caller can’t read are left out.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const runs = await listWorkflowRuns(
        ctx,
        scopeOf(c),
        {
          entryId: c.req.query('entryId') || undefined,
          workflowId: c.req.query('workflowId') || undefined,
          status: oneOf<WorkflowRunStatus>('status', c.req.query('status'), WORKFLOW_RUN_STATUSES),
          limit: limitOf(c.req.query('limit')),
        },
        c.get('principal'),
      );
      return c.json({ items: runs.map(workflowRunView) });
    },
  );
  app.get(
    `${BASE}/workflow-runs/:id`,
    doc('Workflows', 'Get a workflow run', {
      description: 'Status, plan, per-node detail and what it waits on.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json(
        workflowRunView(
          await getWorkflowRun(ctx, scopeOf(c), c.req.param('id'), c.get('principal')),
        ),
      ),
  );
  app.get(
    `${BASE}/workflow-runs/:id/timeline`,
    doc('Workflows', 'Get a run’s timeline', { description: 'Oldest first.' }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json({
        items: await getWorkflowRunTimeline(ctx, scopeOf(c), c.req.param('id'), c.get('principal')),
      }),
  );
  app.get(
    `${BASE}/workflow-runs/:id/node-runs`,
    doc('Workflows', 'List a run’s finished node runs', {
      description: 'Timing, outputs and who each node ran as; oldest first.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json({
        items: await listWorkflowNodeRuns(ctx, scopeOf(c), c.req.param('id'), c.get('principal')),
      }),
  );
  app.post(
    `${BASE}/workflow-runs/:id/cancel`,
    doc('Workflows', 'Cancel a workflow run', {
      body: cancelWorkflowRunBody,
      description:
        'Stops the durable instance, undoes finished compensable steps newest first, closes ' +
        'open tasks and ends the run `cancelled`. Cancelling a finished run does nothing ' +
        '(`ok: false`).',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, cancelWorkflowRunBody);
      return c.json(
        await cancelWorkflowRun(
          actingCtx(ctx, c),
          engine(),
          c.get('principal'),
          scopeOf(c),
          c.req.param('id'),
          body,
          deps.workflowNodes ?? { ai },
        ),
      );
    },
  );
  app.post(
    `${BASE}/workflow-runs/:id/events`,
    doc('Workflows', 'Deliver an event to a run', {
      body: workflowEventBody,
      description:
        'Delivers a business event to the `control.wait_event` node waiting for it. An event ' +
        'nothing waits for yet is held on the run (`buffered: true`) for the first wait for ' +
        'it that opens.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, workflowEventBody);
      return c.json(
        await deliverWorkflowEvent(ctx, engine(), c.get('principal'), scopeOf(c), {
          runId: c.req.param('id'),
          ...body,
        }),
      );
    },
  );

  // --- tasks -----------------------------------------------------------------
  app.get(
    `${BASE}/workflow-tasks`,
    doc('Workflows', 'List workflow tasks', {
      query: {
        status: `One of ${WORKFLOW_TASK_STATUSES.join(', ')}`,
        runId: 'Only this run’s tasks',
        entryId: 'Only tasks on this entry',
        kind: 'approval, event or review',
        limit: 'Default 50, at most 200',
      },
      description:
        'Approvals, event waits and agent reviews runs hold open. Tasks on content types the ' +
        'caller can’t read are left out.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json({
        items: await listWorkflowTasks(
          ctx,
          scopeOf(c),
          {
            status: oneOf('status', c.req.query('status'), WORKFLOW_TASK_STATUSES),
            runId: c.req.query('runId') || undefined,
            entryId: c.req.query('entryId') || undefined,
            kind: oneOf('kind', c.req.query('kind'), TASK_KINDS),
            limit: limitOf(c.req.query('limit')),
          },
          c.get('principal'),
        ),
      }),
  );
  app.get(
    `${BASE}/approvals/count`,
    doc('Workflows', 'Count what waits in Approvals', {
      ok: PENDING_APPROVALS_COUNT,
      description:
        'Pending workflow tasks and pending agent proposals, counted without listing them (no ' +
        'cap). Items on content types the caller can’t read are left out, as the lists leave ' +
        'them out.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await countPendingApprovals(ctx, scopeOf(c), c.get('principal'))),
  );
  app.get(
    `${BASE}/workflow-tasks/:id`,
    doc('Workflows', 'Get a workflow task'),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json(await getWorkflowTask(ctx, scopeOf(c), c.req.param('id'), c.get('principal'))),
  );
  app.post(
    `${BASE}/workflow-tasks/:id/decide`,
    doc('Workflows', 'Approve or reject a task', {
      body: decideWorkflowTaskBody,
      description:
        'Decides an approval (or an agent review a run waits on). The caller needs the task’s ' +
        '`requiredScope` (default `workflow:approve`) and the matching content-type grant. ' +
        'With separation of duties the run’s starter can’t decide, and an API token can’t ' +
        'decide at all (a person must).',
    }),
    // The use-case checks the task's own scope (workflow:approve by default), so an Approver
    // without content:write can decide; reading the task is the floor here.
    requireScope(SCOPES.previewRead),
    async (c) => {
      const body = await parseBody(c, decideWorkflowTaskBody);
      return c.json(
        await decideWorkflowTask(ctx, engine(), c.get('principal'), scopeOf(c), {
          taskId: c.req.param('id'),
          ...body,
        }),
      );
    },
  );

  // --- settings --------------------------------------------------------------
  app.get(
    `${BASE}/workflow-settings`,
    doc('Workflows', 'Read the space’s workflow settings'),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getWorkflowSettings(ctx, scopeOf(c))),
  );
  app.put(
    `${BASE}/workflow-settings`,
    doc('Workflows', 'Set the space’s workflow settings', {
      body: workflowSettingsBody,
      description:
        '`separateDuties` is the default for approvals whose node leaves it unset; it applies ' +
        'to approvals opened from then on. Needs `space:admin`.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, workflowSettingsBody);
      await setWorkflowSeparationDefault(ctx, c.get('principal'), scopeOf(c), body.separateDuties);
      return c.json(await getWorkflowSettings(ctx, scopeOf(c)));
    },
  );

  return app;
}
