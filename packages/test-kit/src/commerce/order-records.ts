/**
 * The order records port in memory, seeded with the orders that exist. The contract in
 * ./order-records-contract.ts holds it to the same behaviour as the D1 store.
 */
import type { OrderIndexRow } from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import type {
  ApprovalRecord,
  ApprovalVoteRecord,
  NewOrderRow,
  NodeRunRecord,
  OrderRecords,
} from '@commerceworker/ports/commerce';

export interface OrderRecordsFixture {
  /** Orders that have started (have a row to index). */
  orders?: string[];
  /** Who started each, by order id; absent is null (a channel or email). */
  startedBy?: Record<string, string>;
  /** The channel each came in on, by order id; absent is `api`, as D1 defaults it. */
  channels?: Record<string, string>;
}

export class InMemoryOrderRecords implements OrderRecords {
  private readonly rows = new Map<string, OrderIndexRow | null>();
  private readonly runRows = new Map<string, NodeRunRecord>();
  private readonly approvalRows: ApprovalRecord[] = [];
  private readonly voteRows: ApprovalVoteRecord[] = [];

  constructor(
    private readonly fixture: OrderRecordsFixture = {},
    private readonly clock: Clock = { now: () => new Date() },
  ) {
    for (const id of fixture.orders ?? []) this.rows.set(id, null);
  }

  async index(orderId: string, row: OrderIndexRow) {
    if (!this.rows.has(orderId)) return false;
    this.rows.set(orderId, { ...row });
    return true;
  }

  private readonly created = new Map<string, NewOrderRow>();

  async create(row: NewOrderRow) {
    const taken = [...this.created.values()].some(
      (o) => row.idempotencyKey && o.idempotencyKey === row.idempotencyKey,
    );
    if (this.rows.has(row.id) || taken) throw new Error('UNIQUE constraint failed: orders');
    this.created.set(row.id, { ...row });
    this.rows.set(row.id, null);
  }

  async staleQueued(before: number, limit: number) {
    return [...this.created.values()]
      .filter(
        (o) =>
          !o.idempotencyKey &&
          o.createdAt < before &&
          (this.rows.get(o.id) ?? { status: 'queued' }).status === 'queued',
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((o) => ({ id: o.id, instanceId: o.instanceId }));
  }

  async failQueued(orderId: string, reason: string) {
    const o = this.created.get(orderId);
    if (!o || (this.rows.get(orderId) ?? { status: 'queued' }).status !== 'queued') return false;
    this.rows.set(orderId, {
      status: 'failed',
      total: 0,
      fxRate: 1,
      customerId: o.customerId,
      title: o.title,
      instanceId: o.instanceId,
      generation: 1,
      waitingOn: null,
      waitingAt: null,
      waitingSince: null,
      waitingDue: null,
      waitingFor: null,
      stoppedAt: null,
      reason,
    });
    return true;
  }

  async exists(orderId: string) {
    return this.rows.has(orderId);
  }

  async byIdempotencyKey(key: string) {
    const o = [...this.created.values()].find((x) => x.idempotencyKey === key);
    return o
      ? {
          id: o.id,
          status: this.rows.get(o.id)?.status ?? 'queued',
          flowId: o.flowId,
          flowVersion: o.flowVersion,
          instanceId: o.instanceId,
          createdAt: o.createdAt,
          fingerprint: o.idempotencyFingerprint,
        }
      : undefined;
  }

  async channel(orderId: string) {
    const made = this.created.get(orderId);
    if (made) return made.channel;
    if (!this.rows.has(orderId)) return undefined;
    return this.fixture.channels?.[orderId] ?? 'api';
  }

  async startedBy(orderId: string) {
    const made = this.created.get(orderId);
    if (made) return made.startedBy;
    if (!this.rows.has(orderId)) return undefined;
    return this.fixture.startedBy?.[orderId] ?? null;
  }

  async indexed(orderId: string) {
    return this.rows.get(orderId) ?? undefined;
  }

  async recordRun(r: NodeRunRecord) {
    const key = `${r.orderId}|${r.generation}|${r.nodeId}|${r.run}`;
    if (!this.runRows.has(key)) this.runRows.set(key, { ...r });
  }

  async runs(orderId: string) {
    return [...this.runRows.values()]
      .filter((r) => r.orderId === orderId)
      .sort(
        (a, b) =>
          a.generation - b.generation ||
          (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0) ||
          a.run - b.run,
      );
  }

  async openApproval(a: Parameters<OrderRecords['openApproval']>[0]) {
    if (this.approvalRows.some((x) => x.orderId === a.orderId && x.eventType === a.eventType))
      return;
    this.approvalRows.push({
      companyId: null,
      approvers: 'staff:approver',
      mode: 'any',
      required: 1,
      eligible: null,
      ...a,
      status: 'pending',
      note: null,
      requestedAt: this.clock.now().getTime(),
      decidedAt: null,
      decidedBy: null,
    });
  }

  async recordVote(
    orderId: string,
    eventType: string,
    vote: Omit<ApprovalVoteRecord, 'approvalId'>,
  ) {
    const ask = this.approvalRows.find((a) => a.orderId === orderId && a.eventType === eventType);
    if (!ask || this.voteRows.some((v) => v.approvalId === ask.id && v.voterId === vote.voterId))
      return false;
    this.voteRows.push({ ...vote, approvalId: ask.id });
    return true;
  }

  async votes(orderId: string, eventType: string) {
    const ask = this.approvalRows.find((a) => a.orderId === orderId && a.eventType === eventType);
    return this.voteRows
      .filter((v) => v.approvalId === ask?.id)
      .sort((a, b) => a.at - b.at || (a.voterId < b.voterId ? -1 : a.voterId > b.voterId ? 1 : 0));
  }

  private change(match: (a: ApprovalRecord) => boolean, to: Partial<ApprovalRecord>) {
    for (const [i, a] of this.approvalRows.entries())
      if (match(a)) this.approvalRows[i] = { ...a, ...to, decidedAt: this.clock.now().getTime() };
  }

  async decideApproval(
    orderId: string,
    eventType: string,
    decision: { status: string; decidedBy: string | null; note: string | null },
  ) {
    this.change((a) => a.orderId === orderId && a.eventType === eventType, decision);
  }

  async cancelApprovals(orderId: string) {
    this.change((a) => a.orderId === orderId && a.status === 'pending', { status: 'cancelled' });
  }

  async approvals(orderId: string) {
    return this.approvalRows
      .filter((a) => a.orderId === orderId)
      .sort((a, b) => a.requestedAt - b.requestedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
