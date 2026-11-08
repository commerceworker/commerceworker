/**
 * The cart records port in memory. The contract in ./cart-records-contract.ts holds it to the
 * same behaviour as the D1 store.
 */
import type { CartIndexRow } from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import type { CartRecord, CartRecords, StaffCart } from '@commerceworker/ports/commerce';

export class InMemoryCartRecords implements CartRecords {
  private readonly rows = new Map<string, CartIndexRow & { purgedAt: number | null }>();

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  async index(row: CartIndexRow) {
    const had = this.rows.get(row.id);
    if (!had) {
      const taken = row.pluginId
        ? [...this.rows.values()].some(
            (r) => r.pluginId === row.pluginId && r.sessionRef === row.sessionRef,
          )
        : false;
      if (taken) throw new Error('UNIQUE constraint failed: carts.plugin_id, carts.session_ref');
      this.rows.set(row.id, { ...row, purgedAt: null });
      return;
    }
    const { title, status, customerId, orderId, updatedAt, expiresAt, buyerId } = row;
    this.rows.set(row.id, {
      ...had,
      title,
      status,
      customerId,
      orderId,
      updatedAt,
      expiresAt,
      buyerId,
    });
  }

  async extendExpiry(id: string, until: number) {
    const r = this.rows.get(id);
    if (r && (r.status === 'open' || r.status === 'locked'))
      this.rows.set(id, { ...r, expiresAt: until });
  }

  async markPurged(id: string) {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, purgedAt: this.clock.now().getTime() });
  }

  private record(r: CartIndexRow & { purgedAt: number | null }): CartRecord {
    return {
      id: r.id,
      status: r.status,
      pluginId: r.pluginId,
      expiresAt: r.expiresAt,
      purgedAt: r.purgedAt,
    };
  }

  async find(id: string) {
    const r = this.rows.get(id);
    return r ? this.record(r) : undefined;
  }

  async list(f: { status?: string; external?: boolean; limit: number }): Promise<CartIndexRow[]> {
    return [...this.rows.values()]
      .filter((r) => (f.external || !r.pluginId) && (!f.status || r.status === f.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, f.limit)
      .map(({ purgedAt: _p, ...r }) => r);
  }

  async staffCarts(f: { status?: string; limit: number }): Promise<StaffCart[]> {
    return [...this.rows.values()]
      .filter((r) => !r.pluginId && (!f.status || r.status === f.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, f.limit)
      .map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        customerId: r.customerId,
        // Names come from the customers table, which this store doesn't hold.
        customer: null,
        flowId: r.flowId,
        orderId: r.orderId,
        updatedAt: r.updatedAt,
      }));
  }

  async forSession(pluginId: string, sessionRef: string) {
    const r = [...this.rows.values()].find(
      (x) => x.pluginId === pluginId && x.sessionRef === sessionRef,
    );
    return r ? this.record(r) : undefined;
  }

  /** The stored row, for tests. */
  row(id: string) {
    return this.rows.get(id);
  }
}
