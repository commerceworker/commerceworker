/**
 * The order records port in memory, seeded with the orders that exist. The contract in
 * ./order-records-contract.ts holds it to the same behaviour as the D1 store.
 */
import type { OrderIndexRow } from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import type {
  ApprovalRecord,
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

  constructor(
    private readonly fixture: OrderRecordsFixture = {},
    private readonly clock: Clock = { now: () => new Date() },
  ) {
    for (const id of fixture.orders ?? []) this.rows.set(id, null);
  }

  async index(orderId: string, row: OrderIndexRow) {
    if (this.rows.has(orderId)) this.rows.set(orderId, { ...row });
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

  async exists(orderId: string) {
    return this.rows.has(orderId);
  }

  async byIdempotencyKey(key: string) {
    const o = [...this.created.values()].find((x) => x.idempotencyKey === key);
    return o
      ? {
          id: o.id,
          status: 'queued',
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

  async openApproval(
    a: Pick<
      ApprovalRecord,
      'id' | 'orderId' | 'nodeId' | 'eventType' | 'title' | 'assignee' | 'amount'
    >,
  ) {
    if (this.approvalRows.some((x) => x.orderId === a.orderId && x.eventType === a.eventType))
      return;
    this.approvalRows.push({
      ...a,
      status: 'pending',
      note: null,
      requestedAt: this.clock.now().getTime(),
      decidedAt: null,
      decidedBy: null,
    });
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
