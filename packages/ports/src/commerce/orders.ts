/**
 * The order read model the OrderAgent keeps in D1 beside its own state: each order's index row
 * (what the orders list and overview read), the timing of every finished step run, and the
 * approvals people decide. The agent's state is the truth; these are its projections, written
 * idempotently so a replayed report changes nothing. `d1OrderRecords` (packages/db) and
 * `InMemoryOrderRecords` (packages/test-kit) implement it, held to one contract.
 */
import type { OrderIndexRow } from '@commerceworker/core';

/** One finished run of one step, for the dashboard's timings. */
export interface NodeRunRecord {
  readonly orderId: string;
  readonly generation: number;
  readonly nodeId: string;
  readonly run: number;
  readonly nodeType: string;
  readonly model: string;
  readonly status: 'succeeded' | 'failed';
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly orderId: string;
  readonly nodeId: string;
  readonly eventType: string;
  readonly title: string;
  readonly assignee: string;
  readonly amount: number | null;
  readonly status: string;
  readonly note: string | null;
  readonly requestedAt: number;
  readonly decidedAt: number | null;
  readonly decidedBy: string | null;
}

/** An order's row as it starts. */
export interface NewOrderRow {
  readonly id: string;
  readonly model: string;
  readonly channel: string;
  readonly externalId: string | null;
  readonly contactEmail: string | null;
  readonly title: string;
  readonly flowId: string;
  readonly flowVersion: number;
  readonly instanceId: string;
  readonly customerId: string | null;
  readonly currency: string;
  readonly createdAt: number;
  readonly idempotencyKey: string | null;
  readonly idempotencyFingerprint: string | null;
  readonly startedBy: string | null;
}

export interface OrderRecords {
  /**
   * Starts an order's row, queued. Idempotency keys are unique: an order started under the same
   * key first makes this throw, and the caller replays that one.
   */
  create(row: NewOrderRow): Promise<void>;
  /** Whether an order with the id was started. */
  exists(orderId: string): Promise<boolean>;
  /** The order started under an idempotency key, as a replay needs it. */
  byIdempotencyKey(key: string): Promise<
    | {
        id: string;
        status: string;
        flowId: string;
        flowVersion: number;
        instanceId: string | null;
        createdAt: number;
        fingerprint: string | null;
      }
    | undefined
  >;
  /**
   * Writes the order's index row. The order's row is created when the order starts; an order with
   * none is left alone.
   */
  index(orderId: string, row: OrderIndexRow): Promise<void>;
  /** The channel an order came in on, or undefined for an unknown order. */
  channel(orderId: string): Promise<string | undefined>;
  /** Who started the order (null for channels and email), or undefined for an unknown order. */
  startedBy(orderId: string): Promise<string | null | undefined>;
  /** The order's index row as last written, or undefined for an unknown order. */
  indexed(orderId: string): Promise<OrderIndexRow | undefined>;
  /** Records a finished run once by order, generation, step and run. */
  recordRun(run: NodeRunRecord): Promise<void>;
  /** The order's recorded runs. */
  runs(orderId: string): Promise<NodeRunRecord[]>;
  /** Opens an approval once per order and wait: a replay keeps the first. */
  openApproval(
    a: Pick<
      ApprovalRecord,
      'id' | 'orderId' | 'nodeId' | 'eventType' | 'title' | 'assignee' | 'amount'
    >,
  ): Promise<void>;
  /** Records the decision on the order's approval for this wait. */
  decideApproval(
    orderId: string,
    eventType: string,
    decision: { status: string; decidedBy: string | null; note: string | null },
  ): Promise<void>;
  /** Cancels the order's pending approvals. */
  cancelApprovals(orderId: string): Promise<void>;
  /** The order's approvals, oldest first. */
  approvals(orderId: string): Promise<ApprovalRecord[]>;
}
