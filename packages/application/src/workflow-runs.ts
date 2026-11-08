/**
 * Workflow runs: their state, node runs, timeline and human tasks.
 *
 * Reporting (sequenced plan snapshots with stale-drop, "a retried attempt keeps its first start",
 * "only the first end of a running node counts", keyed timeline dedupe, status frozen once
 * terminal, capped reasons), opening and closing waits (the tasks table), deciding, delivering
 * events, continuing as a new generation and cancelling (terminate, then compensate). A run's
 * state is a D1 row written with optimistic concurrency (`rev`) inside a unit of work that also
 * appends the run's outbox events (`workflow_run.*`, `workflow.task_opened`).
 *
 * Runs execute on Cloudflare Workflows (the interpreter in @commerceworker/agent-runtime); this
 * module only talks to them through the `WorkflowEngine` port.
 */

import {
  authorize,
  authorizeApproval,
  authorizeContent,
  ConflictError,
  type ContentAction,
  canAccessContentType,
  capReason,
  EARLY_EVENT_CAP,
  EARLY_EVENT_TTL_MS,
  type EarlyEvent,
  ForbiddenError,
  InvalidStateError,
  initPlan,
  isPersonPrincipal,
  isTrigger,
  MANUAL_TRIGGER,
  MAX_EVENT_PAYLOAD_BYTES,
  type NodeRun,
  NotFoundError,
  nodeSpec,
  type PendingWait,
  type PermissionScope,
  type Principal,
  payloadFits,
  principalActorId,
  type RunReport,
  runInstanceId,
  runReason,
  SCOPES,
  type Scope,
  seedAt,
  TERMINAL_WORKFLOW_RUN_STATUSES,
  TIMELINE_CAP,
  type TimelineEntry,
  ValidationError,
  type WorkflowNodeRunRecord,
  type WorkflowRun,
  type WorkflowRunEndType,
  type WorkflowRunParams,
  type WorkflowRunStatus,
  type WorkflowTask,
  type WorkflowTaskStatus,
  type WorkflowTimelineRecord,
} from '@commerceworker/domain';
import {
  type ContentStoreTx,
  TransactionConflictError,
  type WorkflowEngine,
  type WorkflowRunQuery,
  type WorkflowTaskQuery,
} from '@commerceworker/ports';
import { decideAgentReview } from './agent-reviews';
import { recordAudit } from './audit';
import { createChangeLog, withChanges } from './change-log';
import type { AppContext } from './context';
import { compensateWorkflowNode, type WorkflowNodeDeps } from './workflow-nodes/index';

const MAX_NOTE = 2000;
const MAX_EVENT_NAME = 100;
/** Optimistic-concurrency attempts before a write gives up. */
const CAS_ATTEMPTS = 20;

const isTerminal = (s: WorkflowRunStatus) => TERMINAL_WORKFLOW_RUN_STATUSES.includes(s);

const isScope = (s: string): s is PermissionScope =>
  (Object.values(SCOPES) as string[]).includes(s);

/**
 * Refused by separation of duties: the run's
 * starter can't decide its approvals, and an API token can't decide one at all, because a token
 * is never a person whose identity could be told apart from the starter's.
 */
export class SeparationOfDutiesError extends ForbiddenError {
  constructor(reason: 'own_run' | 'token' = 'own_run') {
    super('separation_of_duties');
    this.message =
      reason === 'token'
        ? 'Separation of duties: this approval needs a person; an API token can’t decide it'
        : 'Separation of duties: whoever started this run can’t decide its approvals';
  }
}

// ---- the run row, written with optimistic concurrency -----------------------------------------

interface RunChange {
  readonly run: WorkflowRun;
  readonly logs?: readonly TimelineEntry[];
  readonly nodeRun?: WorkflowNodeRunRecord;
  readonly end?: WorkflowRunEndType;
  /**
   * More writes in the same transaction, after the run row's CAS write (task rows, a race
   * re-check). Return false to abandon the whole change.
   */
  readonly also?: (tx: ContentStoreTx) => Promise<boolean>;
  /** A task this change opens (in `also`), counted in the run's index fields. */
  readonly opens?: WorkflowTask;
}

/**
 * Applies `change` to the run's current row and commits it with the timeline entries, node run
 * and outbox event it implies, retrying from a fresh read when another writer moved the row first.
 * `change` returns null to write nothing.
 */
async function mutateRun(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  change: (run: WorkflowRun) => RunChange | null,
): Promise<WorkflowRun | null> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const cur = await ctx.store.workflowRuns.get(scope, runId);
    if (!cur) throw new NotFoundError('WorkflowRun', runId);
    const c = change(cur);
    if (!c) return cur;
    let logSeq = cur.logSeq;
    const records: WorkflowTimelineRecord[] = (c.logs ?? []).map((e) => {
      logSeq += 1;
      return { ...e, seq: logSeq, key: e.key ?? `#${logSeq}` };
    });
    let next: WorkflowRun = { ...c.run, logSeq };
    const saved = await ctx.store
      .withTransaction(async (tx) => {
        // The index fields follow the run's open tasks, counting the one this change opens.
        // `updatedAt` moves only when an indexed field changed.
        const pending = (
          await tx.workflowTasks.list(scope, { runId, status: 'pending', limit: 200 })
        ).filter((t) => t.id !== c.opens?.id);
        next = { ...next, ...indexFields(next, c.opens ? [...pending, c.opens] : pending) };
        const indexChanged = INDEX_KEYS.some((k) => next[k] !== cur[k]);
        next = {
          ...next,
          rev: cur.rev + 1,
          updatedAt: indexChanged ? ctx.clock.now().toISOString() : cur.updatedAt,
        };
        const unchanged =
          !records.length &&
          !c.nodeRun &&
          !c.end &&
          !c.also &&
          JSON.stringify({ ...next, rev: cur.rev }) === JSON.stringify(cur);
        if (unchanged) return 'unchanged' as const;
        // The CAS write comes first, so losing the race writes nothing and needs no rollback; the
        // change is then recomputed from a fresh read.
        if (!(await tx.workflowRuns.save(scope, next, cur.rev))) return 'retry' as const;
        // Abandoning after the save rolls the whole transaction back.
        if (c.also && !(await c.also(tx))) throw new AbandonRunWrite();
        for (const r of records) await tx.workflowRuns.putTimeline(scope, runId, r);
        if (logSeq > TIMELINE_CAP) {
          await tx.workflowRuns.trimTimeline(scope, runId, logSeq - TIMELINE_CAP);
        }
        if (c.nodeRun) await tx.workflowRuns.recordNodeRun(scope, c.nodeRun);
        if (c.end) {
          await tx.outbox.append({
            id: ctx.ids.newId(),
            type: c.end,
            scope,
            occurredAt: ctx.clock.now().toISOString(),
            runId,
            workflowId: next.workflowId,
            version: next.version,
            entryId: next.entryId,
            contentTypeApiId: next.contentTypeApiId,
            reason: next.reason,
          });
        }
        return 'saved' as const;
      })
      .catch((err: unknown) => {
        if (err instanceof AbandonRunWrite) return 'abandoned' as const;
        // The rev CAS lost at commit (a unit of work reports the precondition only then):
        // nothing was written, so recompute the change from a fresh read.
        if (err instanceof TransactionConflictError) return 'retry' as const;
        throw err;
      });
    if (saved === 'saved') return next;
    if (saved === 'abandoned' || saved === 'unchanged') return cur;
  }
  throw new ConflictError('The workflow run kept changing; try again', { runId });
}

class AbandonRunWrite extends Error {}

/** The fields run lists filter and sort on. */
const INDEX_KEYS = [
  'status',
  'reason',
  'generation',
  'waitingOn',
  'waitingAt',
  'waitingSince',
  'waitingDue',
  'waitingFor',
  'stoppedAt',
] as const satisfies readonly (keyof WorkflowRun)[];

const join = (xs: readonly string[]) => (xs.length ? xs.join(' · ') : null);
const earliest = (xs: readonly string[]) => (xs.length ? ([...xs].sort()[0] ?? null) : null);

/**
 * What the run waits on, at and for, derived from its open tasks plus its timers
 * (`control.wait` nodes waiting).
 */
function indexFields(run: WorkflowRun, pending: readonly WorkflowTask[]) {
  if (isTerminal(run.status)) {
    return {
      waitingOn: null,
      waitingAt: null,
      waitingSince: null,
      waitingDue: null,
      waitingFor: null,
      stoppedAt: stoppedAtOf(run),
    };
  }
  const label = (nodeId: string) => run.nodes[nodeId]?.label ?? nodeId;
  const timers = Object.entries(run.nodes).filter(
    ([, n]) => n.type === 'control.wait' && n.status === 'waiting',
  );
  return {
    waitingOn: join(pending.map((t) => t.title)),
    waitingAt: join([...pending.map((t) => label(t.nodeId)), ...timers.map(([id]) => label(id))]),
    waitingSince: earliest([
      ...pending.map((t) => t.requestedAt),
      ...timers.flatMap(([, n]) =>
        n.startedAt !== undefined ? [new Date(n.startedAt).toISOString()] : [],
      ),
    ]),
    waitingDue: earliest(pending.map((t) => t.deadline)),
    waitingFor: join([
      ...pending.map((t) =>
        t.kind === 'event' ? `event:${t.event ?? ''}` : `person:${t.assignee ?? ''}`,
      ),
      ...timers.map(() => 'timer'),
    ]),
    stoppedAt: null,
  };
}

const endEventFor = (status: WorkflowRunStatus): WorkflowRunEndType | undefined =>
  isTerminal(status) ? (`workflow_run.${status}` as WorkflowRunEndType) : undefined;

/** Where a run that ended badly stopped: the nodes that failed. */
function stoppedAtOf(run: WorkflowRun): string | null {
  if (!['failed', 'rolled_back', 'declined', 'cancelled'].includes(run.status)) return null;
  const failed = Object.entries(run.nodes)
    .filter(([, n]) => n.status === 'failed' || n.error)
    .map(([id, n]) => n.label ?? id);
  return failed.length ? failed.join(' · ') : null;
}

// ---- starting -----------------------------------------------------------------------------------

export interface StartWorkflowRunInput {
  readonly entryId: string;
  readonly workflowId: string;
  /** A published version; the latest when omitted. */
  readonly version?: number;
  readonly input?: Record<string, unknown>;
  readonly vars?: Record<string, unknown>;
  readonly triggerEventId?: string;
  /** Start at this node instead of the trigger (the legacy transition shim). */
  readonly startAt?: string;
}

/**
 * Starts a run of a published workflow version on an entry ("Submit for review"). The caller
 * needs `content:write` on the entry's content type; the run then acts as the caller, so every
 * node is authorized as if they made the call. One active run per workflow and entry.
 */
export async function startWorkflowRun(
  ctx: AppContext,
  engine: WorkflowEngine,
  principal: Principal,
  scope: Scope,
  input: StartWorkflowRunInput,
): Promise<WorkflowRun> {
  authorize(principal, SCOPES.contentWrite, scope.spaceId);
  const found = await ctx.store.entries.get(scope, input.entryId);
  if (!found) throw new NotFoundError('Entry', input.entryId);
  const contentTypeApiId = found.entry.contentTypeApiId;
  authorizeContent(principal, 'write', contentTypeApiId);

  const version =
    input.version !== undefined
      ? await ctx.store.workflowGraphs.getVersion(scope, input.workflowId, input.version)
      : await ctx.store.workflowGraphs.getLatestVersion(scope, input.workflowId);
  if (!version) {
    if (input.version !== undefined) {
      throw new NotFoundError('WorkflowVersion', `${input.workflowId}@${input.version}`);
    }
    if (!(await ctx.store.workflowGraphs.get(scope, input.workflowId))) {
      throw new NotFoundError('Workflow', input.workflowId);
    }
    throw new InvalidStateError('Publish the workflow before starting runs of it');
  }
  if (version.contentTypes.length > 0 && !version.contentTypes.includes(contentTypeApiId)) {
    throw new InvalidStateError(`This workflow doesn’t cover ${contentTypeApiId} entries`);
  }
  const trigger = version.graph.nodes.find(isTrigger);
  if (!input.startAt && trigger?.type !== MANUAL_TRIGGER) {
    throw new InvalidStateError('This workflow starts from its trigger, not by hand');
  }
  if (input.startAt && !version.graph.nodes.some((n) => n.id === input.startAt)) {
    throw new ValidationError([{ field: 'startAt', message: `No node “${input.startAt}”` }]);
  }
  for (const [field, value] of [
    ['input', input.input ?? {}],
    ['vars', input.vars ?? {}],
  ] as const) {
    if (!payloadFits(value)) {
      throw new ValidationError([
        { field, message: `must be at most ${MAX_EVENT_PAYLOAD_BYTES} bytes of JSON` },
      ]);
    }
  }
  const active = (
    await ctx.store.workflowRuns.list(scope, {
      entryId: input.entryId,
      workflowId: input.workflowId,
      limit: 200,
    })
  ).find((r) => !isTerminal(r.status));
  if (active) {
    throw new ConflictError('This entry already has an active run of this workflow', {
      runId: active.id,
    });
  }

  const now = ctx.clock.now();
  const id = ctx.ids.newId();
  const plan = initPlan(version.graph);
  if (input.startAt) seedAt(version.graph, plan, input.startAt);
  const actor = { id: principalActorId(principal), principal };
  const run: WorkflowRun = {
    id,
    workflowId: version.id,
    version: version.version,
    generation: 1,
    entryId: input.entryId,
    contentTypeApiId,
    status: 'queued',
    reason: null,
    plan,
    nodes: Object.fromEntries(
      Object.entries(plan.nodes).map(([nid, pn]) => [nid, { status: pn.status, runs: pn.runs }]),
    ),
    vars: { ...(input.vars ?? {}) },
    input: { ...(input.input ?? {}) },
    seq: 0,
    waitingOn: null,
    waitingAt: null,
    waitingSince: null,
    waitingDue: null,
    waitingFor: null,
    stoppedAt: null,
    earlyEvents: [],
    startedBy: actor,
    triggerEventId: input.triggerEventId ?? null,
    instanceId: runInstanceId(id, 1),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    logSeq: 1,
    rev: 1,
  };
  await ctx.store.workflowRuns.create(scope, run);
  await ctx.store.workflowRuns.putTimeline(scope, id, {
    seq: 1,
    key: 'created',
    at: now.getTime(),
    kind: 'run',
    message: `Run started on ${version.name} v${version.version}`,
  });
  const params: WorkflowRunParams = {
    runId: id,
    scope,
    workflowId: version.id,
    version: version.version,
    generation: 1,
    entryId: input.entryId,
    actor,
    vars: run.vars,
    input: run.input,
    startedAt: now.getTime(),
    ...(input.startAt ? { startAt: input.startAt } : {}),
  };
  await engine.start(run.instanceId, params);
  return run;
}

// ---- reports from the interpreter -----------------------------------------------------------

/**
 * Records what the interpreter reports:
 * - a sequenced plan snapshot applies only when newer (higher generation, or higher `seq` in the
 *   same generation), so a replay never moves the run backwards; a node a failure or rollback
 *   marked keeps that status;
 * - a status change is ignored once the run is terminal;
 * - node detail keeps a retried attempt's first start, and only the first end of a running node
 *   records a node run, so replayed reports never add rows;
 * - a timeline entry with a key replaces its earlier copy.
 */
export async function reportRun(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  r: RunReport,
): Promise<void> {
  await mutateRun(ctx, scope, runId, (s) => {
    let next: WorkflowRun = { ...s };
    const logs: TimelineEntry[] = [];
    const gen = r.generation ?? s.generation;
    const sequenced = r.seq !== undefined;
    const fresh =
      !sequenced || gen > s.generation || (gen === s.generation && (r.seq as number) > s.seq);

    if (sequenced && fresh) {
      next = { ...next, seq: r.seq as number };
      if (r.plan) {
        const nodes: Record<string, NodeRun> = { ...next.nodes };
        for (const [id, pn] of Object.entries(r.plan.nodes)) {
          const cur = nodes[id] ?? { status: 'pending', runs: 0 };
          // Rollback and failure come from their own reports; a later plan never clears them.
          const keep = cur.status === 'rolled_back' || cur.status === 'failed';
          nodes[id] = {
            ...cur,
            status: keep ? cur.status : pn.status,
            runs: pn.runs,
            ...(pn.branches ? { branches: pn.branches } : {}),
          };
        }
        next = { ...next, nodes, plan: r.plan };
      }
      if (r.vars) next = { ...next, vars: r.vars };
    }
    if (r.status && (fresh || !sequenced) && !isTerminal(s.status)) {
      next = { ...next, status: r.status };
      // Capped here, whoever reported it: lists and webhooks show it whole.
      if (r.reason !== undefined) next = { ...next, reason: runReason(r.reason) || null };
      if (r.status !== s.status) {
        logs.push({
          at: ctx.clock.now().getTime(),
          kind: 'run',
          message: `Run ${r.status}${next.reason ? `: ${next.reason}` : ''}`,
          key: `status:${gen}:${r.status}`,
        });
      }
    }

    let nodeRun: WorkflowNodeRunRecord | undefined;
    if (r.node) {
      const { id, ...detail } = r.node;
      const type = detail.type;
      const cur = next.nodes[id] ?? { status: 'pending', runs: 0 };
      const running = cur.startedAt !== undefined && cur.endedAt === undefined;
      const patch: Partial<NodeRun> = { ...detail };
      if (patch.startedAt !== undefined) {
        // A retried attempt keeps the run's first start; a new run starts afresh.
        if (running) patch.startedAt = cur.startedAt;
        else patch.endedAt = undefined;
      }
      const merged: NodeRun = { ...cur, ...patch };
      for (const k of Object.keys(merged) as (keyof NodeRun)[]) {
        if (merged[k] === undefined) delete merged[k];
      }
      next = { ...next, nodes: { ...next.nodes, [id]: merged } };
      // Only the first end of a running node counts, so replayed reports never add a row.
      if (
        running &&
        type &&
        detail.endedAt !== undefined &&
        detail.endedAt >= (cur.startedAt as number)
      ) {
        const startedAt = cur.startedAt as number;
        nodeRun = {
          runId,
          generation: gen,
          nodeId: id,
          run: Math.max(1, merged.runs),
          nodeType: type,
          model: answeredBy(merged.output),
          ranBy: merged.ranBy ?? null,
          status: merged.status === 'failed' || merged.error ? 'failed' : 'succeeded',
          summary: merged.summary ?? null,
          output: merged.output ?? null,
          error: merged.error ?? null,
          startedAt,
          endedAt: detail.endedAt,
          durationMs: detail.endedAt - startedAt,
        };
      }
    }
    if (r.log) logs.push(r.log);

    const ended = !isTerminal(s.status) && isTerminal(next.status);
    return {
      run: next,
      logs,
      ...(nodeRun ? { nodeRun } : {}),
      ...(ended ? { end: endEventFor(next.status) } : {}),
    };
  });
}

/** Records that the run continued as a new generation. */
export async function recordRunContinued(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  generation: number,
): Promise<void> {
  await mutateRun(ctx, scope, runId, (s) =>
    generation <= s.generation
      ? null
      : {
          run: { ...s, generation, seq: 0, instanceId: runInstanceId(runId, generation) },
          logs: [
            {
              at: ctx.clock.now().getTime(),
              kind: 'run',
              message: `Continued as run ${generation}`,
              key: `gen:${generation}`,
            },
          ],
        },
  );
}

// ---- waits and tasks ---------------------------------------------------------------------------

/** For AI node outputs: what answered (the model tier, or `heuristic`). Null for other nodes. */
function answeredBy(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as { source?: unknown; tier?: unknown };
  if (o.source === 'model') return typeof o.tier === 'string' ? o.tier : 'model';
  return o.source === 'heuristic' ? 'heuristic' : null;
}

/** What opening a wait produced: the task, and an event that arrived before the wait opened. */
export interface OpenedWorkflowTask {
  readonly task: WorkflowTask;
  /** The payload of an early event this wait consumed; the run takes it without waiting. */
  readonly early: Record<string, unknown> | null;
}

/**
 * Opens a wait: an approval, an event wait or an agent review becomes a
 * task row, the node's run starts when the wait opens, and `workflow.task_opened` goes out. An
 * approval that leaves `separateDuties` unset takes the space's default. An event wait first
 * looks for a matching early event (delivered before it opened, within `EARLY_EVENT_TTL_MS`) and
 * consumes it. Called from the interpreter's memoized `:open` step; a repeat is a no-op.
 */
export async function openWorkflowTask(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  w: PendingWait,
): Promise<OpenedWorkflowTask> {
  const existing = await ctx.store.workflowTasks.getByEvent(scope, runId, w.eventType);
  if (existing) return { task: existing, early: null };
  const separateDuties =
    w.separateDuties ??
    (w.kind === 'approval'
      ? ((await ctx.store.spaces.getConfig(scope))?.workflowSeparateDuties ?? false)
      : false);
  const taskId = ctx.ids.newId();
  let early: EarlyEvent | null = null;
  await mutateRun(ctx, scope, runId, (s) => {
    const now = ctx.clock.now().getTime();
    const fresh = s.earlyEvents.filter((e) => now - e.at <= EARLY_EVENT_TTL_MS);
    const i = w.kind === 'event' ? fresh.findIndex((e) => e.event === w.event) : -1;
    early = i >= 0 ? (fresh[i] ?? null) : null;
    const earlyEvents = i >= 0 ? fresh.filter((_, j) => j !== i) : fresh;
    const t: WorkflowTask = {
      id: taskId,
      runId,
      workflowId: s.workflowId,
      nodeId: w.nodeId,
      eventType: w.eventType,
      kind: w.kind,
      entryId: s.entryId,
      contentTypeApiId: s.contentTypeApiId,
      title: capReason(w.title, 200),
      instructions: w.instructions ?? '',
      assignee: w.assignee || null,
      event: w.event ?? null,
      requiredScope: w.requiredScope ?? null,
      separateDuties,
      reviewId: w.reviewId ?? null,
      deadline: new Date(w.deadline).toISOString(),
      status: 'pending',
      requestedAt: new Date(w.since).toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: null,
      startedBy: s.startedBy.id,
    };
    const node = s.nodes[w.nodeId] ?? { status: 'pending', runs: 0 };
    const opened: NodeRun = { ...node, startedAt: w.since };
    delete opened.endedAt;
    return {
      run: { ...s, earlyEvents, nodes: { ...s.nodes, [w.nodeId]: opened } },
      logs: [
        {
          at: w.since,
          nodeId: w.nodeId,
          kind: w.kind === 'approval' ? 'approval' : w.kind === 'review' ? 'ai' : 'event',
          // An event wait reads by its step, as a step's own lines do.
          message:
            w.kind === 'approval'
              ? `Awaiting approval: ${t.title}${t.assignee ? ` (${t.assignee})` : ''}`
              : w.kind === 'review'
                ? `Awaiting review: ${t.title}`
                : `${t.title}: waiting`,
          key: `open:${w.eventType}`,
        },
      ],
      opens: t,
      also: async (tx) => {
        if (!(await tx.workflowTasks.create(scope, t))) return false;
        await tx.outbox.append({
          id: ctx.ids.newId(),
          type: 'workflow.task_opened',
          scope,
          occurredAt: ctx.clock.now().toISOString(),
          taskId: t.id,
          runId,
          nodeId: t.nodeId,
          kind: t.kind,
          entryId: t.entryId,
          contentTypeApiId: t.contentTypeApiId,
          title: t.title,
          assignee: t.assignee,
          requiredScope: t.requiredScope,
          deadline: t.deadline,
        });
        return true;
      },
    };
  });
  const task = await ctx.store.workflowTasks.getByEvent(scope, runId, w.eventType);
  if (!task) throw new NotFoundError('WorkflowTask', w.eventType);
  const consumed = early as EarlyEvent | null;
  return {
    task,
    early: consumed ? { ...consumed.payload, event: consumed.event, at: consumed.at } : null,
  };
}
const TASK_OUTCOMES: Record<string, WorkflowTaskStatus> = {
  approved: 'approved',
  rejected: 'rejected',
  escalated: 'escalated',
  received: 'received',
  timeout: 'timeout',
  applied: 'applied',
};

/**
 * Closes a wait: settles the task with the outcome and who decided, and
 * logs it. Called from the interpreter's memoized `:close` step.
 */
export async function closeWorkflowTask(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  eventType: string,
  outcome: string,
  payload: Record<string, unknown>,
  label?: string,
): Promise<void> {
  const task = await ctx.store.workflowTasks.getByEvent(scope, runId, eventType);
  const timedOut = outcome === 'escalated' || outcome === 'timeout';
  if (task?.status === 'pending') {
    await ctx.store.workflowTasks.settle(scope, task.id, {
      status: TASK_OUTCOMES[outcome] ?? 'received',
      decidedAt: ctx.clock.now().toISOString(),
      decidedBy: typeof payload.by === 'string' ? payload.by : timedOut ? 'timeout' : null,
      note: typeof payload.note === 'string' ? payload.note : null,
    });
  }
  const who = task?.kind === 'approval' ? task.title : (label ?? task?.title ?? eventType);
  await mutateRun(ctx, scope, runId, (s) => ({
    run: s,
    logs: [
      {
        at: ctx.clock.now().getTime(),
        ...(task ? { nodeId: task.nodeId } : {}),
        kind: task?.kind === 'approval' ? 'approval' : task?.kind === 'review' ? 'ai' : 'event',
        message: task
          ? `${who}: ${timedOut ? 'timed out' : outcome}${payload.by ? ` by ${String(payload.by)}` : ''}${payload.note ? ` — “${String(payload.note)}”` : ''}`
          : outcome,
        key: `close:${eventType}`,
      },
    ],
  }));
}

// ---- people acting on runs -----------------------------------------------------------------------

export interface DecideWorkflowTaskInput {
  readonly taskId: string;
  readonly decision: 'approved' | 'rejected';
  readonly note?: string;
}

export interface DecideWorkflowTaskResult {
  readonly taskId: string;
  readonly runId: string;
  readonly decision: 'approved' | 'rejected';
  readonly by: string;
}

/**
 * Approves or rejects an approval (or an agent review a run waits on):
 * 1. the task must be pending and its decision window open;
 * 2. the decider needs the task's `requiredScope` in the space **and** the content-type grant
 *    (`read` for `workflow:approve`, `publish` for `content:publish`, else `write`);
 * 3. with separate duties, whoever started the run can't decide;
 * 4. the decision is sent to the run as its durable event; the run closes the task itself;
 * 5. the decision is audited.
 */
export async function decideWorkflowTask(
  ctx: AppContext,
  engine: WorkflowEngine,
  principal: Principal,
  scope: Scope,
  input: DecideWorkflowTaskInput,
): Promise<DecideWorkflowTaskResult> {
  if (input.decision !== 'approved' && input.decision !== 'rejected') {
    throw new ValidationError([{ field: 'decision', message: 'must be approved or rejected' }]);
  }
  if (
    input.note !== undefined &&
    (typeof input.note !== 'string' || input.note.length > MAX_NOTE)
  ) {
    throw new ValidationError([{ field: 'note', message: `at most ${MAX_NOTE} characters` }]);
  }
  const task = await ctx.store.workflowTasks.get(scope, input.taskId);
  if (!task) throw new NotFoundError('WorkflowTask', input.taskId);
  if (task.kind === 'event') {
    throw new InvalidStateError('An event wait is delivered as an event, not decided');
  }
  // An approval that names no scope takes the node's default, `workflow:approve`.
  const required = task.requiredScope ?? SCOPES.workflowApprove;
  if (!isScope(required)) throw new InvalidStateError(`Unknown required scope “${required}”`);
  const action: ContentAction = authorizeApproval(principal, required, scope.spaceId);
  authorizeContent(principal, action, task.contentTypeApiId);
  if (task.status !== 'pending') throw new InvalidStateError(`This task is already ${task.status}`);
  const by = principalActorId(principal);
  if (task.separateDuties) {
    // A token id is never a person: refuse explicitly rather than compare it with the starter.
    if (principal.kind !== 'user' || !principal.subject) throw new SeparationOfDutiesError('token');
    if (by === task.startedBy) throw new SeparationOfDutiesError('own_run');
  }
  if (ctx.clock.now().toISOString() > task.deadline) {
    throw new InvalidStateError('The decision window has closed');
  }
  const run = await ctx.store.workflowRuns.get(scope, task.runId);
  if (!run) throw new NotFoundError('WorkflowRun', task.runId);
  if (isTerminal(run.status)) throw new InvalidStateError(`The run is ${run.status}`);

  if (task.kind === 'review' && task.reviewId) {
    // The review's own decision path applies an approval exactly once; the run then follows it.
    await decideAgentReview(ctx, scope, task.reviewId, {
      approve: input.decision === 'approved',
      decidedBy: by,
    });
  }
  await engine.sendEvent(run.instanceId, task.eventType, {
    decision: input.decision,
    by,
    note: input.note ?? null,
    // "Starter, then approver": a person who approves becomes who the run acts as downstream of
    // this approval. A token's decision names no actor, so the run keeps acting as before; nor
    // does an approver who can't write content (the Approver preset), whose authority would
    // refuse the run's own later steps.
    ...(input.decision === 'approved' &&
    isPersonPrincipal(principal) &&
    principal.scopes.includes(SCOPES.contentWrite)
      ? { actor: { id: by, principal } }
      : {}),
  });
  await recordAudit(ctx, {
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    actor: by,
    action: `workflow.task.${input.decision}`,
    targetType: 'workflow_task',
    targetId: task.id,
    status: 200,
  });
  return { taskId: task.id, runId: run.id, decision: input.decision, by };
}

export interface DeliverWorkflowEventInput {
  readonly runId: string;
  /** The event name a `control.wait_event` node waits for (e.g. `legal.cleared`). */
  readonly event: string;
  readonly payload?: Record<string, unknown>;
}

/**
 * Delivers a business event to whichever node of the run waits for it.
 * The payload lands in the run's vars, so it is bounded. An event no node waits for yet is held on
 * the run (`buffered: true`, at most `EARLY_EVENT_CAP`, for `EARLY_EVENT_TTL_MS`) and taken by the
 * first wait for it that opens, instead of being refused.
 */
export async function deliverWorkflowEvent(
  ctx: AppContext,
  engine: WorkflowEngine,
  principal: Principal,
  scope: Scope,
  input: DeliverWorkflowEventInput,
): Promise<{ delivered: boolean; buffered?: boolean; nodeId?: string }> {
  if (typeof input.event !== 'string' || !input.event || input.event.length > MAX_EVENT_NAME) {
    throw new ValidationError([
      { field: 'event', message: `a name of at most ${MAX_EVENT_NAME} characters` },
    ]);
  }
  const payload = input.payload ?? {};
  if (typeof payload !== 'object' || Array.isArray(payload) || !payloadFits(payload)) {
    throw new ValidationError([
      { field: 'payload', message: `an object of at most ${MAX_EVENT_PAYLOAD_BYTES} bytes` },
    ]);
  }
  authorize(principal, SCOPES.contentWrite, scope.spaceId);
  const run = await ctx.store.workflowRuns.get(scope, input.runId);
  if (!run) throw new NotFoundError('WorkflowRun', input.runId);
  authorizeContent(principal, 'write', run.contentTypeApiId);
  if (isTerminal(run.status)) return { delivered: false };
  const findWait = async (tasks: ContentStoreTx['workflowTasks']) =>
    (await tasks.list(scope, { runId: run.id, status: 'pending', kind: 'event' })).find(
      (t) => t.event === input.event,
    );
  let wait = await findWait(ctx.store.workflowTasks);
  if (!wait) {
    // Nothing waits for it yet: hold it on the run until a wait for it opens (early
    // events are buffered, not refused). Re-checked inside the write, so an event
    // racing the wait's opening is sent rather than held.
    const at = ctx.clock.now().getTime();
    let raced = false;
    const held = await mutateRun(ctx, scope, run.id, (s) =>
      isTerminal(s.status)
        ? null
        : {
            run: {
              ...s,
              earlyEvents: [
                ...s.earlyEvents.filter((e) => at - e.at <= EARLY_EVENT_TTL_MS),
                { event: input.event, payload, at },
              ].slice(-EARLY_EVENT_CAP),
            },
            also: async (tx) => {
              raced = (await findWait(tx.workflowTasks)) !== undefined;
              return !raced;
            },
          },
    );
    if (!raced) {
      if (!held || isTerminal(held.status)) return { delivered: false };
      return { delivered: false, buffered: true };
    }
    wait = await findWait(ctx.store.workflowTasks);
    if (!wait) return { delivered: false };
  }
  await engine.sendEvent(run.instanceId, wait.eventType, {
    ...payload,
    event: input.event,
    at: ctx.clock.now().getTime(),
  });
  await recordAudit(ctx, {
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    actor: principalActorId(principal),
    action: 'workflow.event.delivered',
    targetType: 'workflow_run',
    targetId: run.id,
    status: 200,
  });
  return { delivered: true, nodeId: wait.nodeId };
}

export interface CancelWorkflowRunResult {
  readonly ok: boolean;
  /** What compensation undid, newest step first. */
  readonly undone: readonly string[];
}

/**
 * Cancels a run: stops the durable instance, undoes every finished
 * compensable step in reverse order (each once — a step already rolled back is skipped), closes its
 * open tasks and ends it `cancelled`. Cancelling a finished run does nothing.
 */
export async function cancelWorkflowRun(
  ctx: AppContext,
  engine: WorkflowEngine,
  principal: Principal,
  scope: Scope,
  runId: string,
  input: { readonly reason?: string } = {},
  deps: WorkflowNodeDeps = {},
): Promise<CancelWorkflowRunResult> {
  authorize(principal, SCOPES.contentWrite, scope.spaceId);
  const run = await ctx.store.workflowRuns.get(scope, runId);
  if (!run) throw new NotFoundError('WorkflowRun', runId);
  authorizeContent(principal, 'write', run.contentTypeApiId);
  if (isTerminal(run.status)) return { ok: false, undone: [] };
  const reason = capReason(input.reason?.trim() || 'Cancelled by a person');
  try {
    await engine.cancel(run.instanceId);
  } catch {
    // An instance that is already gone has nothing left to stop.
  }
  // What undoing a node writes goes on this run's row, and on the surface's when it is collecting.
  const changes = ctx.changes ?? createChangeLog();
  const undoing = withChanges(ctx, changes);
  const undone: string[] = [];
  const rolledBack: string[] = [];
  const done = (await ctx.store.workflowRuns.listNodeRuns(scope, runId))
    .filter((r) => r.status === 'succeeded' && nodeSpec(r.nodeType)?.rollback)
    .reverse();
  for (const r of done) {
    try {
      undone.push(
        await compensateWorkflowNode(undoing, deps, {
          scope,
          runId,
          workflowId: run.workflowId,
          entryId: run.entryId,
          generation: r.generation,
          nodeId: r.nodeId,
          run: r.run,
          nodeType: r.nodeType,
          output: r.output,
          effectKey: `${r.nodeId}#${r.run}${r.generation > 1 ? `@g${r.generation}` : ''}`,
          // Undone as whoever ran it.
          ranBy: r.ranBy ?? run.startedBy.id,
        }),
      );
      rolledBack.push(r.nodeId);
    } catch (err) {
      undone.push(`${r.nodeId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const at = ctx.clock.now().toISOString();
  for (const t of await ctx.store.workflowTasks.list(scope, { runId, status: 'pending' })) {
    await ctx.store.workflowTasks.settle(scope, t.id, {
      status: 'cancelled',
      decidedAt: at,
      decidedBy: principalActorId(principal),
      note: null,
    });
  }
  const ended = await mutateRun(ctx, scope, runId, (s) => {
    if (isTerminal(s.status)) return null;
    const nodes = { ...s.nodes };
    for (const id of rolledBack) {
      const n = nodes[id];
      if (n) nodes[id] = { ...n, status: 'rolled_back' };
    }
    const next: WorkflowRun = {
      ...s,
      status: 'cancelled',
      reason,
      nodes,
      earlyEvents: [],
    };
    return {
      run: next,
      logs: [
        {
          at: ctx.clock.now().getTime(),
          kind: 'run',
          message: `Cancelled: ${reason}${undone.length ? ` (${undone.join('; ')})` : ''}`,
          key: 'cancel',
        },
      ],
      end: 'workflow_run.cancelled',
    };
  });
  await recordAudit(ctx, {
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    actor: principalActorId(principal),
    action: 'workflow.run.cancelled',
    targetType: 'workflow_run',
    targetId: runId,
    status: 200,
    detail: changes.detail(),
  });
  return { ok: ended?.status === 'cancelled', undone };
}

// ---- reads ---------------------------------------------------------------------------------------
//
// Reads take the caller's principal when a surface serves them: a run, its timeline, node runs and
// tasks expose the entry's content type, so a role-bound principal must hold `read` on it. Lists
// drop what the principal can't read instead of refusing. Without a principal (the interpreter,
// tests) nothing is filtered.

const readable = (principal: Principal | undefined, contentTypeApiId: string) =>
  !principal || canAccessContentType(principal, 'read', contentTypeApiId);

export async function getWorkflowRun(
  ctx: AppContext,
  scope: Scope,
  id: string,
  principal?: Principal,
): Promise<WorkflowRun> {
  const run = await ctx.store.workflowRuns.get(scope, id);
  if (!run) throw new NotFoundError('WorkflowRun', id);
  if (principal) authorizeContent(principal, 'read', run.contentTypeApiId);
  return run;
}

export async function listWorkflowRuns(
  ctx: AppContext,
  scope: Scope,
  query: WorkflowRunQuery = {},
  principal?: Principal,
): Promise<WorkflowRun[]> {
  const runs = await ctx.store.workflowRuns.list(scope, query);
  return runs.filter((r) => readable(principal, r.contentTypeApiId));
}

/** The run's whole timeline (up to `TIMELINE_CAP` entries), oldest first. */
export async function getWorkflowRunTimeline(
  ctx: AppContext,
  scope: Scope,
  id: string,
  principal?: Principal,
): Promise<WorkflowTimelineRecord[]> {
  await getWorkflowRun(ctx, scope, id, principal);
  return ctx.store.workflowRuns.listTimeline(scope, id);
}

/** Finished node runs (timing, outputs), oldest first. */
export async function listWorkflowNodeRuns(
  ctx: AppContext,
  scope: Scope,
  id: string,
  principal?: Principal,
): Promise<WorkflowNodeRunRecord[]> {
  await getWorkflowRun(ctx, scope, id, principal);
  return ctx.store.workflowRuns.listNodeRuns(scope, id);
}

export async function getWorkflowTask(
  ctx: AppContext,
  scope: Scope,
  id: string,
  principal?: Principal,
): Promise<WorkflowTask> {
  const task = await ctx.store.workflowTasks.get(scope, id);
  if (!task) throw new NotFoundError('WorkflowTask', id);
  if (principal) authorizeContent(principal, 'read', task.contentTypeApiId);
  return task;
}

export async function listWorkflowTasks(
  ctx: AppContext,
  scope: Scope,
  query: WorkflowTaskQuery = {},
  principal?: Principal,
): Promise<WorkflowTask[]> {
  const tasks = await ctx.store.workflowTasks.list(scope, query);
  return tasks.filter((t) => readable(principal, t.contentTypeApiId));
}

/**
 * A run as the API and MCP return it. The starter's resolved principal (scopes, content grants)
 * stays internal: callers see who started the run, not what that key may do. Early events show
 * their names and arrival times, not their payloads.
 */
export interface WorkflowRunView
  extends Omit<WorkflowRun, 'startedBy' | 'earlyEvents' | 'rev' | 'logSeq'> {
  readonly startedBy: { readonly id: string };
  readonly earlyEvents: readonly { readonly event: string; readonly at: number }[];
}

export function workflowRunView(run: WorkflowRun): WorkflowRunView {
  const { startedBy, earlyEvents, rev: _rev, logSeq: _logSeq, ...rest } = run;
  return {
    ...rest,
    startedBy: { id: startedBy.id },
    earlyEvents: earlyEvents.map((e) => ({ event: e.event, at: e.at })),
  };
}

/** The space's workflow settings (`separateDuties`: the default for approvals). */
export interface WorkflowSettings {
  readonly separateDuties: boolean;
}

export async function getWorkflowSettings(
  ctx: AppContext,
  scope: Scope,
): Promise<WorkflowSettings> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return { separateDuties: config.workflowSeparateDuties ?? false };
}

/**
 * Sets the space's separation-of-duties default for workflow approvals whose node leaves
 * `separateDuties` unset (it applies to approvals opened from then on). Needs `space:admin`.
 */
export async function setWorkflowSeparationDefault(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  separateDuties: boolean,
): Promise<void> {
  authorize(principal, SCOPES.spaceAdmin, scope.spaceId);
  if (!(await ctx.store.spaces.getConfig(scope))) throw new NotFoundError('Space', scope.spaceId);
  await ctx.store.spaces.setWorkflowSeparateDuties(scope.spaceId, separateDuties);
}
