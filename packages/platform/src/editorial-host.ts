import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { type GraphRunOutcome, makeGraphActivities, runGraph } from '@commerceworker/agent-runtime';
import type { AppContext, WorkflowNodeDeps } from '@commerceworker/application';
import type { WorkflowRunParams } from '@commerceworker/domain';
import type { WorkflowEngine, WorkflowSteps } from '@commerceworker/ports';

/** What one invocation of a run needs, opened per invocation and closed after it. */
export interface EditorialHostDeps {
  readonly ctx: AppContext;
  /** Starts the next generation on continue-as-new. */
  readonly engine: WorkflowEngine;
  /** AI, email and webhook ports the node executors use. */
  readonly nodes: WorkflowNodeDeps;
  close(): Promise<void>;
}

/**
 * The durable host for editorial workflow runs: one Cloudflare Workflows instance per run
 * generation (instance id = run id, `${runId}-g${n}` after continue-as-new), whose payload is the
 * run's `WorkflowRunParams`. It hands Cloudflare's `WorkflowStep` straight to the graph interpreter
 * (`runGraph`), which owns every step name, wait and compensation; this class only binds the
 * activities to real adapters.
 *
 * Wiring is abstract so the production class (`EditorialWorkflow`, which binds D1 and the
 * real AI/email/webhook adapters) and the workers test fixture (in-memory) share this body.
 */
export abstract class EditorialWorkflowBase<Env = unknown> extends WorkflowEntrypoint<
  Env,
  WorkflowRunParams
> {
  /** Opens this invocation's dependencies. */
  protected abstract open(): EditorialHostDeps | Promise<EditorialHostDeps>;

  override async run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ): Promise<GraphRunOutcome> {
    const deps = await this.open();
    try {
      const act = makeGraphActivities({ ctx: deps.ctx, engine: deps.engine, nodes: deps.nodes });
      // The port is the slice of `WorkflowStep` the interpreter uses; Cloudflare's
      // `Serializable<T>` step constraint is what differs, and every step result the
      // interpreter records is plain JSON.
      return await runGraph(step as unknown as WorkflowSteps, act, event.payload);
    } finally {
      await deps.close();
    }
  }
}
