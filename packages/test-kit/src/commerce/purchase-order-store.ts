/**
 * The purchase orders port in memory. The contract in ./purchase-order-store-contract.ts holds it
 * to the same behaviour as the D1 store (packages/db), so use-case tests on it mean what they say
 * about production.
 */
import type {
  PoStatus,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderLine,
} from '@commerceworker/core';
import type {
  PurchaseOrderFilter,
  PurchaseOrderPage,
  PurchaseOrderPaging,
  PurchaseOrderPatch,
  PurchaseOrderScope,
  PurchaseOrderStore,
} from '@commerceworker/ports/commerce';

const sees = (scope: PurchaseOrderScope, companyId: string) =>
  'all' in scope || scope.companyId === companyId;

const sameNumber = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class InMemoryPurchaseOrderStore implements PurchaseOrderStore {
  private readonly rows = new Map<string, { po: PurchaseOrder; lines: PurchaseOrderLine[] }>();

  /** Whether another PO of the company holds this number (cancelled ones don't). */
  private numberTaken(companyId: string, poNumber: string, except?: string) {
    return [...this.rows.values()].some(
      ({ po }) =>
        po.id !== except &&
        po.companyId === companyId &&
        po.status !== 'cancelled' &&
        sameNumber(po.poNumber, poNumber),
    );
  }

  async list(
    scope: PurchaseOrderScope,
    f: PurchaseOrderFilter,
    paging: PurchaseOrderPaging,
  ): Promise<PurchaseOrderPage> {
    const needle = f.search?.trim().toLowerCase();
    const all = [...this.rows.values()]
      .map((r) => r.po)
      .filter(
        (po) =>
          sees(scope, po.companyId) &&
          (!f.companyId || po.companyId === f.companyId) &&
          (!f.status || po.status === f.status) &&
          (!f.buyerId || po.buyerId === f.buyerId) &&
          (!needle || po.poNumber.toLowerCase().includes(needle)) &&
          (f.from === undefined || po.createdAt >= f.from) &&
          (f.to === undefined || po.createdAt <= f.to),
      )
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const { after } = paging;
    const rest = after
      ? all.filter(
          (po) => po.createdAt < after.at || (po.createdAt === after.at && po.id < after.id),
        )
      : all;
    const shown = rest.slice(0, paging.limit);
    const last = shown.at(-1);
    return {
      rows: shown.map((po) => ({
        ...structuredClone(po),
        lineCount: this.rows.get(po.id)?.lines.length ?? 0,
      })),
      total: all.length,
      next: rest.length > paging.limit && last ? { at: last.createdAt, id: last.id } : null,
    };
  }

  async get(scope: PurchaseOrderScope, id: string): Promise<PurchaseOrderDetail | undefined> {
    const r = this.rows.get(id);
    return r && sees(scope, r.po.companyId)
      ? structuredClone({ ...r.po, lines: r.lines })
      : undefined;
  }

  async byNumber(scope: PurchaseOrderScope, companyId: string, poNumber: string) {
    const r = [...this.rows.values()].find(
      ({ po }) =>
        po.companyId === companyId &&
        sees(scope, companyId) &&
        po.status !== 'cancelled' &&
        sameNumber(po.poNumber, poNumber),
    );
    return r && structuredClone(r.po);
  }

  async byOrder(orderId: string) {
    const r = [...this.rows.values()].find(({ po }) => po.orderId === orderId);
    return r && structuredClone(r.po);
  }

  async create(po: PurchaseOrder, lines: readonly PurchaseOrderLine[]) {
    if (this.rows.has(po.id)) return { ok: false as const, conflict: 'id' as const };
    if (po.status !== 'cancelled' && this.numberTaken(po.companyId, po.poNumber))
      return { ok: false as const, conflict: 'number' as const };
    this.rows.set(po.id, { po: structuredClone(po), lines: structuredClone([...lines]) });
    return { ok: true as const };
  }

  async updateDraft(scope: PurchaseOrderScope, id: string, patch: PurchaseOrderPatch, at: number) {
    const r = this.rows.get(id);
    if (r?.po.status !== 'draft' || !sees(scope, r.po.companyId))
      return { ok: false as const, conflict: 'missing' as const };
    if (patch.poNumber !== undefined && this.numberTaken(r.po.companyId, patch.poNumber, id))
      return { ok: false as const, conflict: 'number' as const };
    const { lines, ...header } = patch;
    // Undefined means "leave it", as the D1 store reads it.
    const set = Object.fromEntries(Object.entries(header).filter(([, v]) => v !== undefined));
    r.po = { ...r.po, ...structuredClone(set), updatedAt: at };
    if (lines) r.lines = structuredClone([...lines]);
    return { ok: true as const };
  }

  async transition(
    scope: PurchaseOrderScope,
    id: string,
    from: PoStatus,
    to: PoStatus,
    at: number,
  ) {
    const r = this.rows.get(id);
    if (!r || r.po.status !== from || !sees(scope, r.po.companyId)) return false;
    r.po = { ...r.po, status: to, updatedAt: at };
    return true;
  }

  async linkOrder(scope: PurchaseOrderScope, id: string, orderId: string, at: number) {
    const r = this.rows.get(id);
    if (!r || !sees(scope, r.po.companyId)) return false;
    if (r.po.orderId && r.po.orderId !== orderId) return false;
    if ([...this.rows.values()].some((x) => x.po.id !== id && x.po.orderId === orderId))
      return false;
    r.po = { ...r.po, orderId, updatedAt: at };
    return true;
  }
}
