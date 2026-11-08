import type {
  PendingWaitKind,
  RunContext,
  RunEntry,
  Scope,
  WorkflowNode,
  WorkflowRunActor,
} from '@commerceworker/domain';
import type { AIProvider, DecisionModel, EmailSender, WebhookSender } from '@commerceworker/ports';
import type { AppContext } from '../context';

/**
 * What a node executor returns: the branches it took plus patches the interpreter applies to the
 * run context. `entry` is a fresh snapshot after a node changed the entry.
 *
 * Every field is JSON: the result is the durable step's memoized value, so a replay applies
 * exactly the same patches.
 */
export interface NodeResult {
  branches?: string[];
  output?: unknown;
  summary?: string;
  vars?: Record<string, unknown>;
  entry?: RunEntry;
  /**
   * The node must wait before it can finish (`ai.enrich` awaiting review). The interpreter opens
   * the wait, waits for the event, then calls `resumeNode` with what arrived.
   */
  wait?: NodeWaitRequest;
  /**
   * The node failed in a way retrying can't change (forbidden, invalid state, a validation
   * error). The interpreter fails the node at once instead of spending its retries.
   */
  failed?: string;
}

/** A wait an executor asks the interpreter to open. */
export interface NodeWaitRequest {
  kind: PendingWaitKind;
  /** The durable event type the decision arrives as (e.g. `agent-review-<id>`). */
  eventType: string;
  title: string;
  /** Duration string ("7 days"). */
  timeout: string;
  requiredScope?: string;
  instructions?: string;
  assignee?: string;
  reviewId?: string;
}

/** The ports node executors use beyond the store. Absent ones make their nodes fail clearly. */
export interface WorkflowNodeDeps {
  readonly ai?: AIProvider;
  /** Decision model for the `ai.*` nodes that choose (classify, route, moderate); without one
   *  they ask `ai` for JSON instead. */
  readonly decisions?: DecisionModel;
  readonly email?: EmailSender;
  readonly webhooks?: WebhookSender;
}

/** Everything an executor sees. */
export interface ExecInput {
  readonly ctx: AppContext;
  readonly deps: WorkflowNodeDeps;
  readonly scope: Scope;
  readonly runId: string;
  readonly workflowId: string;
  readonly entryId: string;
  /** Who the run acts as: every effect is authorized against this principal. */
  readonly actor: WorkflowRunActor;
  readonly node: WorkflowNode;
  /** The node's config with catalog defaults filled in. */
  readonly config: Record<string, unknown>;
  /** The run context (`now` refreshed from the clock inside the step). */
  readonly run: RunContext;
  /** The node's idempotency key (`effectKey(generation, stepKey)`). */
  readonly effectKey: string;
  /**
   * The step has attempts left: a failed model call throws so the step retries, rather than
   * answering with the heuristic. False on the last attempt.
   */
  readonly retriesLeft: boolean;
}

export type Exec = (i: ExecInput) => Promise<NodeResult>;

/** What a waiting executor learns once its wait ends. */
export interface ResumeInput extends ExecInput {
  /** The executor's first result (before the wait). */
  readonly before: NodeResult;
  /** The delivered payload, or null when the wait timed out. */
  readonly payload: Record<string, unknown> | null;
}

export type Resume = (i: ResumeInput) => Promise<NodeResult>;

/** What a compensation sees: the node's recorded output and the run it belonged to. */
export interface CompensateInput {
  readonly ctx: AppContext;
  readonly deps: WorkflowNodeDeps;
  readonly scope: Scope;
  readonly runId: string;
  readonly entryId: string;
  readonly nodeType: string;
  readonly output: unknown;
  readonly effectKey: string;
  /** Audit identity the node ran as; its undo runs as the same identity. */
  readonly ranBy: string;
}

/** Undoes a node's effect; returns a sentence for the timeline. Must be idempotent. */
export type Compensate = (i: CompensateInput) => Promise<string>;
