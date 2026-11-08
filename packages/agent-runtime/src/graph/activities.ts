import {
  type AppContext,
  type CompensateWorkflowNodeInput,
  closeWorkflowTask,
  compensateWorkflowNode,
  type ExecuteWorkflowNodeInput,
  executeWorkflowNode,
  isPurging,
  loadRunEntry,
  type NodeResult,
  openWorkflowTask,
  recordRunContinued,
  reportRun,
  resumeWorkflowNode,
  type WorkflowNodeDeps,
} from '@commerceworker/application';
import {
  NotFoundError,
  type PendingWait,
  type RunEntry,
  type RunReport,
  runInstanceId,
  type Scope,
  type WorkflowRunParams,
  type WorkflowVersion,
} from '@commerceworker/domain';
import type { WorkflowEngine } from '@commerceworker/ports';

/**
 * Every side effect the graph interpreter has, behind one interface. The interpreter calls these only inside
 * durable steps (or, for reports, best-effort outside them), so it holds no I/O of its own.
 * Kept separate from the agent `Activities` so each stays a clean set of step-able calls.
 */
export interface GraphActivities {
  /** Epoch ms, for report timestamps and wait deadlines (read inside steps). */
  now(): number;
  loadVersion(scope: Scope, workflowId: string, version: number): Promise<WorkflowVersion | null>;
  loadEntry(scope: Scope, entryId: string): Promise<RunEntry>;
  executeNode(input: ExecuteWorkflowNodeInput): Promise<NodeResult>;
  resumeNode(
    input: ExecuteWorkflowNodeInput & {
      readonly before: NodeResult;
      readonly payload: Record<string, unknown> | null;
    },
  ): Promise<NodeResult>;
  compensateNode(input: CompensateWorkflowNodeInput): Promise<string>;
  report(scope: Scope, runId: string, report: RunReport): Promise<void>;
  /**
   * Opens a wait. Returns the payload of an event delivered before the wait opened (which the
   * wait consumes), or null when the run must wait for it.
   */
  openWait(scope: Scope, runId: string, wait: PendingWait): Promise<Record<string, unknown> | null>;
  closeWait(
    scope: Scope,
    runId: string,
    eventType: string,
    outcome: string,
    payload: Record<string, unknown>,
    label: string,
  ): Promise<void>;
  /** Starts the next generation's instance (retry-safe) and records it on the run. */
  continueAsNew(params: WorkflowRunParams): Promise<string>;
}

export interface GraphActivitiesDeps {
  readonly ctx: AppContext;
  /** AI, email and webhook ports the node executors use. */
  readonly nodes?: WorkflowNodeDeps;
  /** Starts the next generation on continue-as-new. */
  readonly engine: WorkflowEngine;
}

/** The real activities over the application use-cases (the edge host binds them per instance). */
export function makeGraphActivities(deps: GraphActivitiesDeps): GraphActivities {
  const { ctx, engine } = deps;
  const nodeDeps = deps.nodes ?? {};
  // A run in a deleted environment acts on nothing: its rows linger only until purged, so it
  // fails as it would once they are gone (its entry not found) instead of publishing into them.
  const live = async (scope: Scope) => {
    if (await isPurging(ctx, scope)) {
      throw new NotFoundError('Environment', `${scope.spaceId}/${scope.environmentId}`);
    }
  };
  return {
    now: () => ctx.clock.now().getTime(),
    loadVersion: (scope, workflowId, version) =>
      ctx.store.workflowGraphs.getVersion(scope, workflowId, version),
    loadEntry: async (scope, entryId) => {
      await live(scope);
      return loadRunEntry(ctx, scope, entryId);
    },
    executeNode: async (input) => {
      await live(input.scope);
      return executeWorkflowNode(ctx, nodeDeps, input);
    },
    resumeNode: async (input) => {
      await live(input.scope);
      return resumeWorkflowNode(ctx, nodeDeps, input);
    },
    compensateNode: async (input) => {
      await live(input.scope);
      return compensateWorkflowNode(ctx, nodeDeps, input);
    },
    report: (scope, runId, report) => reportRun(ctx, scope, runId, report),
    openWait: async (scope, runId, wait) => (await openWorkflowTask(ctx, scope, runId, wait)).early,
    closeWait: (scope, runId, eventType, outcome, payload, label) =>
      closeWorkflowTask(ctx, scope, runId, eventType, outcome, payload, label),
    continueAsNew: async (params) => {
      const id = runInstanceId(params.runId, params.generation);
      // `start` is idempotent: a retry after the instance was created finds it.
      await engine.start(id, params);
      await recordRunContinued(ctx, params.scope, params.runId, params.generation);
      return id;
    },
  };
}
