import {
  assertCanEnterStep,
  assertValidWorkflow,
  type EntryWorkflowState,
  type GraphIssue,
  graphToLegacySteps,
  isTrigger,
  legacyStepsToGraph,
  NotFoundError,
  nodeSpec,
  parseWorkflowGraph,
  publishGateIssue,
  type Scope,
  ValidationError,
  validateGraph,
  versionGatesPublish,
  type WorkflowGraph,
  type WorkflowGraphDefinition,
  type WorkflowStep,
  type WorkflowVersion,
} from '@commerceworker/domain';
import type { WorkflowGraphRecord } from '@commerceworker/ports';
import type { AppContext } from './context';

/*
 * Editorial workflows are versioned graphs (packages/domain/src/workflow). A workflow row holds
 * the editable draft graph; publishing appends an immutable, numbered `WorkflowVersion` that runs
 * pin. Workflows created before graphs existed are stored only as ordered `steps`; they read back
 * with a graph built by `legacyStepsToGraph`, and their first draft save or publish writes it.
 *
 * Authorization stays at the surfaces (route `requireScope` / MCP tool scope checks), as for every
 * other workflow use-case: reads need `preview:read`, writes `content:manage`.
 */

/** Bounds on a stored graph, so a draft cannot grow without limit. */
export const MAX_WORKFLOW_NODES = 200;
export const MAX_WORKFLOW_EDGES = 400;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;
const MAX_CONTENT_TYPES = 100;

/**
 * A workflow as the API and MCP return it: the legacy `{id, name, steps}` shape (so steps-only
 * clients keep working) plus the draft graph and its version bookkeeping. `steps` is derived from
 * the graph's `content.stage` nodes in graph order.
 */
export interface WorkflowSummary extends WorkflowGraphDefinition {
  /** Assignable to the legacy `WorkflowDefinition` (`{id, name, steps}`). */
  readonly steps: readonly WorkflowStep[];
  /** The draft's flag; {@link publishGated} says whether gating is in force. */
  readonly gatesPublish: boolean;
  /**
   * Whether publish gating is in force: the latest published version gates and a run of it can
   * publish. What publishing checks, which the draft's `gatesPublish` may not match yet.
   */
  readonly publishGated: boolean;
  /** The highest published version, or null if the draft has never been published. */
  readonly latestVersion: number | null;
  /** True when the row is still stored only as legacy steps (its graph is derived on read). */
  readonly legacy: boolean;
  /** ISO-8601; null for a legacy row never saved as a graph. */
  readonly updatedAt: string | null;
}

/** The result of validating a graph: parse (shape) problems surface as errors too. */
export interface WorkflowGraphValidation {
  readonly ok: boolean;
  readonly errors: readonly GraphIssue[];
  readonly warnings: readonly GraphIssue[];
}

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] };

function toSummary(record: WorkflowGraphRecord, publishGated: boolean): WorkflowSummary {
  const legacy = record.graph === null;
  const graph =
    record.graph ?? (record.steps.length > 0 ? legacyStepsToGraph(record) : EMPTY_GRAPH);
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    contentTypes: [...record.contentTypes],
    graph,
    gatesPublish: record.gatesPublish,
    publishGated,
    steps: legacy ? [...record.steps] : graphToLegacySteps(graph),
    latestVersion: record.latestVersion,
    legacy,
    updatedAt: record.updatedAt,
  };
}

async function loadSummary(ctx: AppContext, scope: Scope, id: string): Promise<WorkflowSummary> {
  const record = await ctx.store.workflowGraphs.get(scope, id);
  if (!record) throw new NotFoundError('Workflow', id);
  const latest =
    record.latestVersion === null
      ? null
      : await ctx.store.workflowGraphs.getLatestVersion(scope, id);
  return toSummary(record, latest !== null && versionGatesPublish(latest));
}

/** Parses untrusted graph input or throws a ValidationError naming every shape problem. */
function parseGraphOrThrow(raw: unknown): WorkflowGraph {
  const parsed = parseWorkflowGraph(raw);
  if (!parsed.ok) {
    throw new ValidationError(parsed.issues.map((message) => ({ field: 'graph', message })));
  }
  const issues = sizeIssues(parsed.value);
  if (issues.length > 0) {
    throw new ValidationError(issues.map((message) => ({ field: 'graph', message })));
  }
  return parsed.value;
}

function sizeIssues(graph: WorkflowGraph): string[] {
  const issues: string[] = [];
  if (graph.nodes.length > MAX_WORKFLOW_NODES) {
    issues.push(`A workflow has at most ${MAX_WORKFLOW_NODES} nodes`);
  }
  if (graph.edges.length > MAX_WORKFLOW_EDGES) {
    issues.push(`A workflow has at most ${MAX_WORKFLOW_EDGES} edges`);
  }
  return issues;
}

interface DraftFields {
  readonly name?: string;
  readonly description?: string;
  readonly contentTypes?: readonly string[];
  readonly gatesPublish?: boolean;
}

function checkDraftFields(input: DraftFields): void {
  const issues: { field: string; message: string }[] = [];
  if (input.name !== undefined && (!input.name.trim() || input.name.length > MAX_NAME)) {
    issues.push({ field: 'name', message: `Name must be 1–${MAX_NAME} characters` });
  }
  if (input.description !== undefined && input.description.length > MAX_DESCRIPTION) {
    issues.push({
      field: 'description',
      message: `Description is at most ${MAX_DESCRIPTION} characters`,
    });
  }
  if (input.contentTypes !== undefined) {
    if (input.contentTypes.length > MAX_CONTENT_TYPES) {
      issues.push({
        field: 'contentTypes',
        message: `At most ${MAX_CONTENT_TYPES} content types`,
      });
    }
    if (input.contentTypes.some((t) => typeof t !== 'string' || !t)) {
      issues.push({ field: 'contentTypes', message: 'Content types are non-empty api ids' });
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

async function writeDraft(
  ctx: AppContext,
  scope: Scope,
  def: WorkflowGraphDefinition,
): Promise<WorkflowSummary> {
  await ctx.store.workflowGraphs.saveDraft(scope, {
    ...def,
    steps: graphToLegacySteps(def.graph),
    updatedAt: ctx.clock.now().toISOString(),
  });
  return loadSummary(ctx, scope, def.id);
}

/**
 * Validates a graph without saving it: shape (`parseWorkflowGraph` plus size bounds) and then the
 * semantic checks (`validateGraph`) the editor, the copilot and publishing share. Pure.
 */
export function validateWorkflowGraph(raw: unknown): WorkflowGraphValidation {
  const parsed = parseWorkflowGraph(raw);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.issues.map((message) => ({ message })), warnings: [] };
  }
  const size = sizeIssues(parsed.value);
  if (size.length > 0) {
    return { ok: false, errors: size.map((message) => ({ message })), warnings: [] };
  }
  const { errors, warnings } = validateGraph(parsed.value);
  return { ok: errors.length === 0, errors, warnings };
}

export interface DefineWorkflowInput {
  readonly name: string;
  readonly steps: readonly WorkflowStep[];
}

/**
 * Creates a workflow from legacy ordered steps (the original `POST /workflows {name, steps}`).
 * It converts the steps with `legacyStepsToGraph`, saves that as the draft and publishes it as
 * version 1, so steps-only clients keep working unchanged.
 */
export async function defineWorkflow(
  ctx: AppContext,
  scope: Scope,
  input: DefineWorkflowInput,
): Promise<WorkflowSummary> {
  assertValidWorkflow(input.steps);
  checkDraftFields({ name: input.name });
  const id = ctx.ids.newId();
  await writeDraft(ctx, scope, {
    id,
    name: input.name,
    description: '',
    contentTypes: [],
    graph: legacyStepsToGraph(input),
    gatesPublish: false,
  });
  await publishWorkflowVersion(ctx, scope, id);
  return loadSummary(ctx, scope, id);
}

export interface CreateWorkflowInput extends DraftFields {
  readonly name: string;
  /** Untrusted graph input; defaults to an empty graph. */
  readonly graph?: unknown;
}

/**
 * Creates a graph workflow as an unpublished draft. Drafts may be semantically incomplete (the
 * editor saves work in progress), so `validation` reports problems without refusing; only shape
 * errors refuse. Publish with {@link publishWorkflowVersion}.
 */
export async function createWorkflowDraft(
  ctx: AppContext,
  scope: Scope,
  input: CreateWorkflowInput,
): Promise<{ workflow: WorkflowSummary; validation: WorkflowGraphValidation }> {
  checkDraftFields(input);
  const graph = input.graph === undefined ? EMPTY_GRAPH : parseGraphOrThrow(input.graph);
  const workflow = await writeDraft(ctx, scope, {
    id: ctx.ids.newId(),
    name: input.name,
    description: input.description ?? '',
    contentTypes: [...(input.contentTypes ?? [])],
    graph,
    gatesPublish: input.gatesPublish ?? false,
  });
  return { workflow, validation: withGateWarning(validateWorkflowGraph(graph), workflow) };
}

/**
 * A draft that gates publishing on a graph no run could publish from saves (drafts may be
 * incomplete), with a warning; publishing it is refused ({@link publishWorkflowVersion}).
 */
function withGateWarning(
  validation: WorkflowGraphValidation,
  draft: Pick<WorkflowGraphDefinition, 'graph' | 'gatesPublish'>,
): WorkflowGraphValidation {
  const issue = draft.gatesPublish ? publishGateIssue(draft.graph) : null;
  return issue
    ? { ...validation, warnings: [...validation.warnings, { message: issue }] }
    : validation;
}

export interface SaveWorkflowDraftInput extends DraftFields {
  /** Untrusted graph input; omitted keeps the current draft graph. */
  readonly graph?: unknown;
}

/**
 * Updates a workflow's draft (`PUT /workflows/:id/draft`). Omitted fields keep their value. Saving
 * a legacy steps-only workflow writes its converted graph. Never touches published versions.
 */
export async function saveWorkflowDraft(
  ctx: AppContext,
  scope: Scope,
  id: string,
  input: SaveWorkflowDraftInput,
): Promise<{ workflow: WorkflowSummary; validation: WorkflowGraphValidation }> {
  checkDraftFields(input);
  const current = await loadSummary(ctx, scope, id);
  const graph = input.graph === undefined ? current.graph : parseGraphOrThrow(input.graph);
  const workflow = await writeDraft(ctx, scope, {
    id,
    name: input.name ?? current.name,
    description: input.description ?? current.description,
    contentTypes: [...(input.contentTypes ?? current.contentTypes)],
    graph,
    gatesPublish: input.gatesPublish ?? current.gatesPublish,
  });
  return { workflow, validation: withGateWarning(validateWorkflowGraph(graph), workflow) };
}

export interface PublishWorkflowOptions {
  /** Who published it (a principal/key id), recorded on the version. */
  readonly publishedBy?: string;
}

/**
 * Publishes the current draft as the next immutable version (`POST /workflows/:id/versions`).
 * Refuses with a ValidationError when `validateGraph` reports errors; warnings do not block. A
 * draft that gates publishing must be one a run can publish from (`canPublishThroughRun`):
 * otherwise the gate would lock every entry it covers.
 */
export async function publishWorkflowVersion(
  ctx: AppContext,
  scope: Scope,
  id: string,
  options: PublishWorkflowOptions = {},
): Promise<WorkflowVersion> {
  const draft = await loadSummary(ctx, scope, id);
  const { errors } = validateGraph(draft.graph);
  const gateIssue = draft.gatesPublish ? publishGateIssue(draft.graph) : null;
  if (errors.length > 0 || gateIssue) {
    throw new ValidationError([
      ...errors.map((e) => ({
        field: e.nodeId
          ? `graph.nodes.${e.nodeId}`
          : e.edgeId
            ? `graph.edges.${e.edgeId}`
            : 'graph',
        message: e.message,
      })),
      ...(gateIssue ? [{ field: 'gatesPublish', message: gateIssue }] : []),
    ]);
  }
  const definition: WorkflowGraphDefinition = {
    id: draft.id,
    name: draft.name,
    description: draft.description,
    contentTypes: [...draft.contentTypes],
    graph: draft.graph,
    gatesPublish: draft.gatesPublish,
  };
  // A legacy row's first publish also writes the converted graph as its draft.
  if (draft.legacy) await writeDraft(ctx, scope, definition);
  return ctx.store.workflowGraphs.publishVersion(scope, definition, {
    publishedAt: ctx.clock.now().toISOString(),
    ...(options.publishedBy ? { publishedBy: options.publishedBy } : {}),
  });
}

/** Published versions of a workflow, newest first. */
export async function listWorkflowVersions(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<WorkflowVersion[]> {
  await loadSummary(ctx, scope, id);
  return ctx.store.workflowGraphs.listVersions(scope, id);
}

/**
 * One published version. Deliberately does not require the workflow row to still exist: versions
 * are immutable history that pinned runs keep loading after the definition is deleted.
 */
export async function getWorkflowVersion(
  ctx: AppContext,
  scope: Scope,
  id: string,
  version: number,
): Promise<WorkflowVersion> {
  const found =
    Number.isInteger(version) && version > 0
      ? await ctx.store.workflowGraphs.getVersion(scope, id, version)
      : null;
  if (!found) throw new NotFoundError('WorkflowVersion', `${id}@${version}`);
  return found;
}

/** What starts a workflow: its trigger node's type and the catalog's name for it. */
export interface WorkflowTrigger {
  /** The trigger node type (`trigger.manual`, `trigger.entry_published`, …). */
  readonly type: string;
  /** The node catalog's label ("Submit for review", "Entry published"). */
  readonly label: string;
}

/**
 * A workflow as the list returns it: the summary (with its draft graph) plus how its PUBLISHED
 * version starts, which is what runs, whatever the draft says now.
 */
export interface WorkflowListItem extends WorkflowSummary {
  /** The latest published version's trigger; null when never published (or it has none). */
  readonly publishedTrigger: WorkflowTrigger | null;
  /**
   * The ids of the other published workflows whose latest version starts on the same trigger for
   * some of the same content types (no content types covers every type). Each of them starts too:
   * an event starts every matching workflow, and Submit for review asks the editor which one.
   * Null when this workflow has never been published.
   */
  readonly startsAlongside: readonly string[] | null;
}

const triggerOf = (graph: WorkflowGraph): WorkflowTrigger | null => {
  const t = graph.nodes.find(isTrigger);
  return t ? { type: t.type, label: nodeSpec(t.type)?.label ?? t.label } : null;
};

/** True when two workflows' coverage meets: an empty list covers every content type. */
const overlaps = (a: readonly string[], b: readonly string[]) =>
  a.length === 0 || b.length === 0 || a.some((t) => b.includes(t));

/** Every workflow, with how its published version starts and which others start alongside it. */
export async function listWorkflows(ctx: AppContext, scope: Scope): Promise<WorkflowListItem[]> {
  const records = await ctx.store.workflowGraphs.list(scope);
  const latest = await ctx.store.workflowGraphs.listLatestVersions(
    scope,
    records.filter((r) => r.latestVersion !== null).map((r) => r.id),
  );
  const published = new Map(
    latest.map((v) => [
      v.id,
      { trigger: triggerOf(v.graph), contentTypes: v.contentTypes, gated: versionGatesPublish(v) },
    ]),
  );
  return records.map((record) => {
    const own = published.get(record.id);
    const startsAlongside = !own
      ? null
      : own.trigger
        ? [...published]
            .filter(
              ([id, other]) =>
                id !== record.id &&
                other.trigger?.type === own.trigger?.type &&
                overlaps(own.contentTypes, other.contentTypes),
            )
            .map(([id]) => id)
        : [];
    return {
      ...toSummary(record, own?.gated ?? false),
      publishedTrigger: own?.trigger ?? null,
      startsAlongside,
    };
  });
}

export async function getWorkflow(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<WorkflowSummary> {
  return loadSummary(ctx, scope, id);
}

/** Deletes the workflow's definition row. Published versions are retained (see above). */
export async function deleteWorkflow(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  await getWorkflow(ctx, scope, id);
  await ctx.store.workflows.deleteDefinition(scope, id);
}

export async function getEntryWorkflowState(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
): Promise<EntryWorkflowState | null> {
  return ctx.store.workflows.getState(scope, entryId);
}

export interface TransitionInput {
  readonly entryId: string;
  readonly workflowId: string;
  readonly toStepId: string;
}

/**
 * Moves an entry into a workflow step. The caller must hold the target step's
 * `requiredScope` — enforced here (not by a static route guard) because the
 * required scope is data-driven by the workflow definition. `callerScopes` is
 * the requesting principal's granted scopes, so the SAME rule applies whether
 * the move comes from the HTTP API or an MCP tool.
 *
 * Steps come from the row's `steps` column, which every draft save keeps derived from the
 * graph's `content.stage` nodes; PR 5 reimplements this over graph runs (`seedAt`).
 */
export async function transitionEntry(
  ctx: AppContext,
  scope: Scope,
  input: TransitionInput,
  callerScopes: readonly string[],
): Promise<EntryWorkflowState> {
  if (!(await ctx.store.entries.get(scope, input.entryId))) {
    throw new NotFoundError('Entry', input.entryId);
  }
  const def = await ctx.store.workflows.getDefinition(scope, input.workflowId);
  if (!def) throw new NotFoundError('Workflow', input.workflowId);

  // Resolves the step AND enforces its required scope (throws ForbiddenError).
  assertCanEnterStep(def, input.toStepId, callerScopes);

  const state: EntryWorkflowState = {
    entryId: input.entryId,
    workflowId: input.workflowId,
    currentStepId: input.toStepId,
  };
  await ctx.store.workflows.saveState(scope, state);
  return state;
}
