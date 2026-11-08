/**
 * Node executors for the workflow interpreter: `executeWorkflowNode` runs one node's effects
 * (inside the interpreter's durable step), `resumeWorkflowNode` finishes a node that waited, and
 * `compensateWorkflowNode` undoes a finished node. The control nodes that need durable timers or events
 * (`control.approval`, `control.wait_event`, `control.wait`, `control.loop`, `control.end`,
 * `control.continue_as_new`) are the interpreter's own.
 */

import {
  DomainError,
  evaluateLogic,
  logicHolds,
  NODE_SPECS,
  nodeSpec,
  RateLimitedError,
  type RunContext,
  type Scope,
  ValidationError,
  varsSummary,
  type WorkflowNode,
  type WorkflowRunActor,
  withDefaults,
  workflowActor,
} from '@commerceworker/domain';
import { type AppContext, withActor } from '../context';
import { AI_EXECUTORS, AI_RESUMES } from './ai';
import { WORKFLOW_COMPENSATIONS } from './compensations';
import { CONTENT_EXECUTORS } from './content';
import { isRecord } from './support';
import type { Exec, NodeResult, Resume, WorkflowNodeDeps } from './types';

export { assessHeuristic } from './ai';
export { WORKFLOW_COMPENSATIONS } from './compensations';
export { loadRunEntry } from './support';
export type * from './types';

/** Node types the interpreter runs itself (durable timers, events, loops, endings). */
export const INTERPRETED_NODE_TYPES: readonly string[] = [
  'control.approval',
  'control.wait_event',
  'control.wait',
  'control.loop',
  'control.end',
  'control.continue_as_new',
];

const passthrough: Exec = async () => ({ summary: 'Started' });

const CONTROL_EXECUTORS: Record<string, Exec> = {
  // Pure, but inside a step so `now` and friends replay identically.
  'control.condition': async ({ config, run }) => {
    const v = logicHolds(config.expression, run);
    return {
      branches: [v ? 'true' : 'false'],
      output: { value: v },
      summary: v ? 'true' : 'false',
    };
  },
  'control.set': async ({ config, run }) => {
    const assign = isRecord(config.assign) ? config.assign : {};
    const vars = Object.fromEntries(
      Object.entries(assign).map(([k, expr]) => [k, evaluateLogic(expr, run) ?? null]),
    );
    return {
      vars,
      output: vars,
      summary: varsSummary(vars),
    };
  },
};

/** Every node type's executor, by type. */
export const WORKFLOW_EXECUTORS: Record<string, Exec> = {
  ...Object.fromEntries(
    NODE_SPECS.filter((s) => s.category === 'trigger').map((s) => [s.type, passthrough]),
  ),
  ...CONTENT_EXECUTORS,
  ...CONTROL_EXECUTORS,
  ...AI_EXECUTORS,
};

/** Executors that can ask to wait, and what they do once the wait ends. */
export const WORKFLOW_RESUMES: Record<string, Resume> = { ...AI_RESUMES };

export interface ExecuteWorkflowNodeInput {
  readonly scope: Scope;
  readonly runId: string;
  readonly workflowId: string;
  readonly entryId: string;
  readonly actor: WorkflowRunActor;
  readonly node: WorkflowNode;
  readonly run: RunContext;
  readonly effectKey: string;
  readonly retriesLeft: boolean;
}

/** A failure retrying can't change: authorization, validation, state, missing things. */
const permanent = (err: unknown): err is DomainError =>
  err instanceof DomainError && !(err instanceof RateLimitedError);

/** A validation error names its fields, so the run’s reason says what was wrong. */
const failureMessage = (err: DomainError): string =>
  err instanceof ValidationError && err.issues.length
    ? err.issues.map((i) => (i.field ? `${i.field} ${i.message}` : i.message)).join('; ')
    : err.message;

const clean = (r: NodeResult): NodeResult => JSON.parse(JSON.stringify(r)) as NodeResult;

function prepare(ctx: AppContext, deps: WorkflowNodeDeps, input: ExecuteWorkflowNodeInput) {
  return {
    // A node's writes are the workflow's: authorship names it, not the person it acts for (whose
    // grants still decide what it may do, through `actor`).
    ctx: withActor(ctx, workflowActor(input.workflowId)),
    deps,
    scope: input.scope,
    runId: input.runId,
    workflowId: input.workflowId,
    entryId: input.entryId,
    actor: input.actor,
    node: input.node,
    config: withDefaults(input.node.type, input.node.config),
    // The step reads the clock: its result is memoized, so the replay sees the same `now`.
    run: { ...input.run, now: ctx.clock.now().getTime() },
    effectKey: input.effectKey,
    retriesLeft: input.retriesLeft,
  };
}

/**
 * Runs one node's executor. Domain failures (forbidden, invalid, not found) come back as
 * `{ failed }` so the interpreter fails the node without spending retries; anything else throws
 * and the durable step retries it.
 */
export async function executeWorkflowNode(
  ctx: AppContext,
  deps: WorkflowNodeDeps,
  input: ExecuteWorkflowNodeInput,
): Promise<NodeResult> {
  const exec = WORKFLOW_EXECUTORS[input.node.type];
  if (!exec) {
    return {
      failed: nodeSpec(input.node.type)
        ? `${input.node.type} runs in the interpreter`
        : `No executor for ${input.node.type}`,
    };
  }
  try {
    return clean(await exec(prepare(ctx, deps, input)));
  } catch (err) {
    if (permanent(err)) return { failed: failureMessage(err) };
    throw err;
  }
}

/** Finishes a node that waited (`NodeResult.wait`), given what arrived (null on timeout). */
export async function resumeWorkflowNode(
  ctx: AppContext,
  deps: WorkflowNodeDeps,
  input: ExecuteWorkflowNodeInput & {
    readonly before: NodeResult;
    readonly payload: Record<string, unknown> | null;
  },
): Promise<NodeResult> {
  const resume = WORKFLOW_RESUMES[input.node.type];
  if (!resume) return { failed: `${input.node.type} cannot wait` };
  try {
    return clean(
      await resume({ ...prepare(ctx, deps, input), before: input.before, payload: input.payload }),
    );
  } catch (err) {
    if (permanent(err)) return { failed: failureMessage(err) };
    throw err;
  }
}

export interface CompensateWorkflowNodeInput {
  readonly scope: Scope;
  readonly runId: string;
  /** The run's workflow: its compensations are written as it, as its nodes were. */
  readonly workflowId: string;
  readonly entryId: string;
  readonly generation: number;
  readonly nodeId: string;
  /** The node's iteration (the `#n` of its step key). */
  readonly run: number;
  readonly nodeType: string;
  readonly output: unknown;
  readonly effectKey: string;
  /** Audit identity the node ran as (its compensation runs as the same identity). */
  readonly ranBy: string;
}

/**
 * Undoes one finished node, once: a node run already marked rolled back is skipped, and the
 * compensation itself checks the entry is as the node left it. Returns a timeline sentence.
 */
export async function compensateWorkflowNode(
  ctx: AppContext,
  deps: WorkflowNodeDeps,
  input: CompensateWorkflowNodeInput,
): Promise<string> {
  const compensate = WORKFLOW_COMPENSATIONS[input.nodeType];
  if (!compensate) return 'Nothing to undo';
  const key = {
    runId: input.runId,
    generation: input.generation,
    nodeId: input.nodeId,
    run: input.run,
  };
  const record = (await ctx.store.workflowRuns.listNodeRuns(input.scope, input.runId)).find(
    (r) => r.generation === key.generation && r.nodeId === key.nodeId && r.run === key.run,
  );
  if (record?.status === 'rolled_back') return 'Already undone';
  const message = await compensate({
    ctx: withActor(ctx, workflowActor(input.workflowId)),
    deps,
    scope: input.scope,
    runId: input.runId,
    entryId: input.entryId,
    nodeType: input.nodeType,
    output: input.output,
    effectKey: input.effectKey,
    ranBy: input.ranBy,
  });
  await ctx.store.workflowRuns.markNodeRunRolledBack(input.scope, key);
  return message;
}
