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
  /** The company whose members vote, for company, team and members approvers. */
  readonly companyId: string | null;
  /** Who may vote as the flow wrote it: `staff:approver`, `company:approver`, `team:<id>`, … */
  readonly approvers: string;
  /** any | all | majority | quorum. */
  readonly mode: string;
  /** The approvals that decide it, resolved when the wait opened. */
  readonly required: number;
  /** The voters' ids, resolved when the wait opened; null when any staff with the role may decide. */
  readonly eligible: readonly string[] | null;
}

/** One vote on an approval, unique per approval and voter. */
export interface ApprovalVoteRecord {
  readonly approvalId: string;
  /** A staff principal's id, or a company member's. */
  readonly voterId: string;
  readonly voterKind: 'staff' | 'member';
  /** The staff principal who recorded a member's vote for them (D3); null for one's own. */
  readonly onBehalfBy: string | null;
  readonly decision: 'approved' | 'rejected';
  readonly note: string | null;
  readonly at: number;
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
  /** The company member placing it (`meta.buyerId`), when the order names one. */
  readonly buyerId?: string | null;
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
  /**
   * Opens an approval once per order and wait: a replay keeps the first. Who may vote is optional:
   * left out, it is any one staff approver, as every approval was before approvers were named.
   */
  openApproval(
    a: Pick<
      ApprovalRecord,
      'id' | 'orderId' | 'nodeId' | 'eventType' | 'title' | 'assignee' | 'amount'
    > &
      Partial<Pick<ApprovalRecord, 'companyId' | 'approvers' | 'mode' | 'required' | 'eligible'>>,
  ): Promise<void>;
  /**
   * Records a vote on the order's approval for this wait, once per voter: true when it was new,
   * false when the voter had already voted (the first vote stays), or when there is no such
   * approval.
   */
  recordVote(
    orderId: string,
    eventType: string,
    vote: Omit<ApprovalVoteRecord, 'approvalId'>,
  ): Promise<boolean>;
  /** The votes on the order's approval for this wait, oldest first. */
  votes(orderId: string, eventType: string): Promise<ApprovalVoteRecord[]>;
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
