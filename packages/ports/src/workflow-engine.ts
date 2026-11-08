import type { WorkflowRunParams } from '@commerceworker/domain';

/**
 * The durable-execution seams the workflow graph interpreter runs on.
 *
 * Workflow runs execute only on Cloudflare Workflows. {@link WorkflowSteps} is the slice of the
 * Workflows `WorkflowStep` API the interpreter uses, typed here so the interpreter (and the test
 * harness in test-kit) never import Cloudflare types: the edge host passes its `WorkflowStep`
 * straight through. {@link WorkflowEngine} is the start/signal/cancel seam the application uses
 * (the edge implements it over the `EDITORIAL_WF` binding), mirroring how `AgentRunner` decouples
 * the application from the agent runtime.
 */

/** A duration in ms, or a Workflows duration string ("30 seconds", "2 days"). */
export type WorkflowDuration = number | string;

/** Per-step retry and timeout policy (Cloudflare's `WorkflowStepConfig`). */
export interface WorkflowStepConfig {
  readonly retries?: {
    /** Retries after the first attempt. */
    readonly limit: number;
    readonly delay: WorkflowDuration;
    readonly backoff?: 'constant' | 'linear' | 'exponential';
  };
  readonly timeout?: WorkflowDuration;
}

/** What a step callback learns about its attempt (Cloudflare's `WorkflowStepContext`). */
export interface WorkflowStepContext {
  /** 1 on the first try. */
  readonly attempt: number;
}

/** A delivered event (Cloudflare's `WorkflowStepEvent`). */
export interface WorkflowStepEvent<T> {
  readonly type: string;
  readonly payload: T;
  readonly timestamp: Date;
}

/**
 * Durable steps. Every method is keyed by `name`: a step that already finished returns its
 * recorded result on replay instead of running again, so results must be JSON-serializable.
 */
export interface WorkflowSteps {
  do<T>(name: string, fn: (ctx: WorkflowStepContext) => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    fn: (ctx: WorkflowStepContext) => Promise<T>,
  ): Promise<T>;
  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  /** Resolves with the first event of `type`; rejects when `timeout` passes first. */
  waitForEvent<T>(
    name: string,
    options: { readonly type: string; readonly timeout?: WorkflowDuration },
  ): Promise<WorkflowStepEvent<T>>;
}

/**
 * Starts, signals and stops durable run instances. Instance ids are the run id for the first
 * generation and `${runId}-g${n}` after a continue-as-new (`runInstanceId`).
 */
export interface WorkflowEngine {
  /** Creates the instance. Idempotent: an instance that already exists is left as is. */
  start(instanceId: string, params: WorkflowRunParams): Promise<void>;
  /** Delivers an event to a waiting instance (`step.waitForEvent`). */
  sendEvent(instanceId: string, type: string, payload: Record<string, unknown>): Promise<void>;
  /** Stops the instance. A missing or finished instance is not an error. */
  cancel(instanceId: string): Promise<void>;
}
