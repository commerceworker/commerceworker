/**
 * The admin's view of the orders index and what each order left in D1: the orders list and its
 * count, the overview, the approvals inbox, an order's records, a recorded order's runs, and the
 * lists that hang off them. Read only; the engine writes all of it. `d1OrderBoard`
 * (packages/db) and `InMemoryOrderBoard` (packages/test-kit) implement it, held to one contract.
 *
 * An order "has a run" when the engine named its Workflow instance in the index. A recorded order
 * (one `pnpm db:seed:volume` wrote straight into the index) has none, so nothing can resume it: no
 * open-status filter, live count, queue or wait includes it.
 */
import type { ApprovalRecord, NodeRunRecord } from './orders';
import type { PaymentRecord } from './payments';

/** An order's row in the index. */
export interface IndexedOrder {
  readonly id: string;
  readonly model: string;
  readonly channel: string;
  readonly externalId: string | null;
  readonly contactEmail: string | null;
  readonly status: string;
  readonly title: string;
  readonly flowId: string;
  readonly flowVersion: number;
  /** Null for a recorded order. */
  readonly instanceId: string | null;
  readonly generation: number;
  readonly customerId: string | null;
  readonly currency: string;
  readonly total: number;
  readonly waitingOn: string | null;
  /** The labels of the steps holding its open waits, joined with ` · `. */
  readonly waitingAt: string | null;
  readonly waitingSince: number | null;
  /** When the soonest open wait times out; a wait at or past it is overdue. */
  readonly waitingDue: number | null;
  /** What the open waits are on, joined with ` · `: `person:<role>`, `event:<name>` or `timer`. */
  readonly waitingFor: string | null;
  readonly stoppedAt: string | null;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly idempotencyKey: string | null;
  readonly idempotencyFingerprint: string | null;
  /** Units of its currency per unit of the base currency, when it started. */
  readonly fxRate: number;
  readonly startedBy: string | null;
  readonly erasedAt: number | null;
  readonly addressPending: number | null;
}

export interface BoardFilter {
  readonly model?: string;
  readonly channel?: string;
  /** `declined` includes cancelled orders whose approval was rejected or escalated. */
  readonly status?: string;
  /** Text in the id (a leading `#` is dropped), title, customer id or name, email or external id. */
  readonly q?: string;
  /**
   * Newest first by default. `oldest` is created ascending, `updated` most recent first, `total`
   * largest first in the base currency, `waiting` the longest-held first (orders not waiting last).
   */
  readonly sort?: 'created' | 'oldest' | 'updated' | 'total' | 'waiting';
  /** Only what needs a person: failed, rolled back, or with a run and a pending approval. */
  readonly attention?: boolean;
  readonly flow?: string;
  readonly customer?: string;
  /** Waiting at, or stopped at, this step's label (alone or among several). */
  readonly step?: string;
  /** Only orders updated at or after this time. */
  readonly updatedSince?: number;
  /** Newest-first paging: only orders created before this one. */
  readonly after?: { readonly createdAt: number; readonly id: string };
}

/** An approval as the inbox lists it, with its order, flow and customer. */
export interface ApprovalRow {
  readonly id: string;
  readonly orderId: string;
  readonly nodeId: string;
  readonly title: string;
  readonly assignee: string;
  readonly amount: number | null;
  readonly status: string;
  readonly note: string | null;
  readonly requestedAt: number;
  readonly decidedAt: number | null;
  readonly decidedBy: string | null;
  /** The order's fields are null when its order is gone. */
  readonly orderModel: string | null;
  readonly orderTitle: string | null;
  /** The step's label in the flow version the order pinned; null when that version lacks it. */
  readonly stepLabel: string | null;
  readonly flowId: string | null;
  readonly flowName: string | null;
  readonly currency: string | null;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly fxRate: number | null;
  readonly startedBy: string | null;
  /** The company whose members vote; null for staff approvers. */
  readonly companyId: string | null;
  /** The company's name, when the approval has one. */
  readonly companyName: string | null;
  readonly approvers: string;
  readonly mode: string;
  /** The approvals that decide it. */
  readonly required: number;
  /** The votes so far, for the tally ("1 of 2"). */
  readonly approved: number;
  readonly rejected: number;
  /** How many approvals have this status in this scope, across every page. */
  readonly total: number;
}

/** What narrows the approvals inbox beyond its status and scope. */
export interface ApprovalFilter {
  /** Approvals of this company's members. */
  readonly companyId?: string;
  /** Approvals this voter may vote on: a company member's id (or a staff principal's, once resolved). */
  readonly approver?: string;
}

/** A vote as an order page shows it: who, on which approval step, and who recorded it. */
export interface ApprovalVoteView {
  readonly approvalId: string;
  readonly nodeId: string;
  readonly voterId: string;
  readonly voterKind: 'staff' | 'member';
  readonly voterName: string | null;
  readonly onBehalfBy: string | null;
  readonly onBehalfName: string | null;
  readonly decision: 'approved' | 'rejected';
  readonly note: string | null;
  readonly at: number;
}

/**
 * `live`: approvals on orders with a run, which a decision resumes. `recorded`: on orders with none
 * (or gone), which nothing can decide. Unset: every approval.
 */
export type ApprovalScope = 'live' | 'recorded';

/** Where a page of approvals ended: the last row's request time and id (ids break ties). */
export type ApprovalCursor = { readonly requestedAt: number; readonly id: string };

export interface ApprovalPage {
  readonly rows: ApprovalRow[];
  /** How many rows the pages before this one held. */
  readonly from: number;
  readonly total: number;
  readonly next: ApprovalCursor | null;
}

/** A company member who may vote on one of an order's pending approvals. */
export interface ApprovalVoter {
  readonly approvalId: string;
  readonly nodeId: string;
  readonly memberId: string;
  readonly name: string;
}

export interface Overview {
  /** Open orders with a run, by status. */
  readonly open: { status: string; n: number }[];
  /** The 8 most recently updated orders. */
  readonly recent: IndexedOrder[];
  /** The 5 longest-waiting live approvals. */
  readonly approvals: ApprovalRow[];
  /** How many live approvals are pending. */
  readonly pendingApprovals: number;
  /** What ended in the 24 hours before `now`, by status, with its total in the base currency. */
  readonly ended24h: { status: string; n: number; total: number }[];
  /** Orders declined by policy in those 24 hours. */
  readonly declined24h: number;
  /** Where open orders with a run wait, by flow and step, with the oldest wait and how many are overdue. */
  readonly waitsByFlow: {
    flowId: string;
    at: string | null;
    for: string | null;
    n: number;
    oldest: number | null;
    overdue: number;
  }[];
  /** Failed or rolled back in the week before `now`, by flow and step, most first, with the latest reason. */
  readonly stoppedWeek: {
    flowId: string;
    at: string | null;
    n: number;
    rolledBack: number;
    latest: number;
    reason: string | null;
  }[];
}

/** What an order left in D1 besides its index row, each list newest first (sellers by id). */
export interface OrderRecordsView {
  readonly documents: {
    id: string;
    orderId: string;
    kind: string;
    r2Key: string;
    contentType: string;
    createdAt: number;
  }[];
  readonly messages: {
    id: string;
    orderId: string;
    recipient: string;
    subject: string;
    body: string;
    createdAt: number;
  }[];
  readonly payments: PaymentRecord[];
  readonly shipments: {
    id: string;
    orderId: string;
    carrier: string;
    tracking: string;
    status: string;
    provider: string | null;
    externalId: string | null;
    createdAt: number;
  }[];
  /** A seller no longer on file reads as `Marketplace`. */
  readonly sellers: {
    sellerId: string;
    name: string;
    status: string;
    subtotal: number;
    reason: string | null;
  }[];
  readonly payouts: {
    sellerId: string;
    name: string | null;
    status: string;
    net: number;
    commission: number;
  }[];
  readonly invoices: {
    id: string;
    status: string;
    number: string | null;
    hostedUrl: string | null;
    amount: number;
    currency: string;
    dueAt: number | null;
  }[];
}

/** What each compensation left on one order's records, counted. */
export interface Undone {
  readonly reservationsReleased: number;
  readonly authorizationsVoided: number;
  readonly sellerOrdersCancelled: number;
  readonly payoutsReversed: number;
  readonly shipmentsCancelled: number;
  readonly invoicesVoided: number;
  readonly codesRevoked: number;
}

/** A recorded run of one step, with how long it took. */
export type RecordedRun = Omit<NodeRunRecord, 'status'> & {
  readonly status: string;
  readonly durationMs: number;
};

/** The order a record belongs to, for a list of records across orders. */
export interface RecordOrder {
  readonly orderId: string;
  readonly orderTitle: string;
  readonly customerName: string | null;
  readonly contactEmail: string | null;
}

/** The latest records orders wrote, by kind, each newest first. */
export interface RecentRecords {
  readonly payments: (RecordOrder & PaymentRecord)[];
  readonly invoices: (RecordOrder & {
    id: string;
    number: string | null;
    provider: string;
    terms: string;
    amount: number;
    currency: string;
    status: string;
    createdAt: number;
  })[];
  readonly payouts: (RecordOrder & {
    id: string;
    sellerId: string;
    /** Null when the seller is no longer on file. */
    seller: string | null;
    gross: number;
    commission: number;
    net: number;
    status: string;
    createdAt: number;
  })[];
  readonly shipments: (RecordOrder & {
    id: string;
    carrier: string;
    tracking: string;
    status: string;
    createdAt: number;
  })[];
  /** Stock held for orders, and the store holding it (null for the warehouse). */
  readonly holds: (RecordOrder & {
    id: string;
    sku: string;
    qty: number;
    location: string | null;
    status: string;
    createdAt: number;
  })[];
  readonly sellerOrders: (RecordOrder & {
    id: string;
    sellerId: string;
    seller: string | null;
    subtotal: number;
    reason: string | null;
    status: string;
    createdAt: number;
  })[];
  readonly messages: (RecordOrder & {
    id: string;
    recipient: string;
    subject: string;
    createdAt: number;
  })[];
  readonly documents: (RecordOrder & {
    id: string;
    kind: string;
    contentType: string;
    createdAt: number;
  })[];
}

/**
 * The Performance page's aggregates since a time: days are UTC dates (`YYYY-MM-DD`), money is in
 * the base currency at each order's rate, and an ended order counts on the day it ended (its last
 * update).
 */
export interface PerformanceFigures {
  /** Ended orders by type, most first, and how many of them completed. */
  readonly completion: { model: string; finished: number; completed: number }[];
  /**
   * Each node type's run count and nearest-rank p50 and p95 duration (the run at ceil(p × n) in
   * its sorted durations), slowest p95 first.
   */
  readonly nodes: { type: string; n: number; p50: number; p95: number }[];
  /** Completed orders' totals, by day. */
  readonly revenue: { day: string; total: number }[];
  /** Succeeded captures and charges (collected) and refunds, by day. */
  readonly money: { day: string; collected: number; refunded: number }[];
  /** Ended orders by day and status. */
  readonly endings: { day: string; status: string; n: number }[];
}

export interface OrderBoard {
  /** The Performance page's aggregates since `since`. */
  performance(since: number): Promise<PerformanceFigures>;
  /**
   * The latest `perKind` records of each kind, in one round trip. With `q` (case-insensitive,
   * matched literally, a leading `#` dropped), only those whose order (id, title, contact email,
   * customer) or own fields match: a payment's ref or processor id, an invoice's number, a
   * payout's or seller order's seller, a shipment's carrier or tracking, a hold's SKU, a
   * message's recipient or subject, a document's kind. A record whose order is gone is left out.
   */
  recentRecords(q: string, perKind: number): Promise<RecentRecords>;
  /** The orders a filter picks, up to `limit`, in its sort. */
  list(filter: BoardFilter, limit: number): Promise<IndexedOrder[]>;
  /** How many orders a filter picks across every page (its `after` ignored), at most `cap`. */
  count(filter: BoardFilter, cap: number): Promise<{ n: number; more: boolean }>;
  /** Everything the overview shows, as of `now`, in one round trip. */
  overview(now: number): Promise<Overview>;
  /**
   * A page of approvals with `status` (`all` for every one). Pending reads oldest request first,
   * the rest newest first; pages are keyed by the last row, so a decision taken meanwhile shifts
   * nothing.
   */
  approvals(
    status: string,
    after: ApprovalCursor | null,
    limit: number,
    scope?: ApprovalScope,
    filter?: ApprovalFilter,
  ): Promise<ApprovalPage>;
  /** The votes on an order's approvals, oldest first, with their voters' names. */
  votes(orderId: string): Promise<ApprovalVoteView[]>;
  /** The company members who may vote on the order's pending approvals, by name. */
  voters(orderId: string): Promise<ApprovalVoter[]>;
  /** Pending approvals, by whether a decision can resume their order. */
  pendingApprovalCounts(): Promise<{ live: number; recorded: number }>;
  /** An order's records, in one round trip. */
  records(orderId: string): Promise<OrderRecordsView>;
  /**
   * An order's row, its generation's recorded runs (oldest first), its approvals (oldest first),
   * and, when it rolled back, what its records show was undone.
   */
  recorded(orderId: string): Promise<
    | {
        order: IndexedOrder;
        runs: RecordedRun[];
        approvals: ApprovalRecord[];
        undone: Undone | null;
      }
    | undefined
  >;
  /**
   * Orders with a run that are waiting or running on an outside event (`event:` in `waitingFor`):
   * the `limit` most recently updated, how many in all, and how many are overdue at `now`.
   */
  waitingOnEvents(
    limit: number,
    now: number,
  ): Promise<{ orders: IndexedOrder[]; total: number; overdue: number }>;
  /** Open orders with a run, per flow and version. */
  runningByFlow(): Promise<{ flowId: string; version: number; n: number }[]>;
  /** Of these order ids, the cancelled orders declined by policy (an approval rejected or escalated). */
  declinedOrderIds(ids: readonly string[]): Promise<string[]>;
  /** The email intake log, newest first. */
  inboundEmails(limit: number): Promise<InboundEmailRow[]>;
}

export interface InboundEmailRow {
  readonly id: string;
  readonly messageId: string;
  readonly mailbox: string;
  readonly sender: string;
  readonly subject: string;
  readonly status: string;
  readonly reason: string | null;
  readonly orderId: string | null;
  readonly r2Key: string | null;
  readonly attachments: number;
  readonly receivedAt: number;
}
