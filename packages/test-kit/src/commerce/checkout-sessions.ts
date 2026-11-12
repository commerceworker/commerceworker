/**
 * The checkout sessions port in memory, kept as JSON as the D1 store keeps them, so a caller can't
 * change a stored session by holding on to the object it wrote. The contract in
 * ./checkout-sessions-contract.ts holds it to the same behaviour as the D1 store.
 */
import type { CheckoutSession } from '@commerceworker/core';
import type { CheckoutSessionStore } from '@commerceworker/ports/commerce';

export class InMemoryCheckoutSessions implements CheckoutSessionStore {
  private readonly rows = new Map<string, { ownerId: string; version: number; data: string }>();

  async create(s: CheckoutSession) {
    if (this.rows.has(s.id)) throw new Error('UNIQUE constraint failed: checkout_sessions.id');
    if (s.orderId && [...this.rows.values()].some((r) => this.parse(r.data).orderId === s.orderId))
      throw new Error('UNIQUE constraint failed: checkout_sessions.order_id');
    this.rows.set(s.id, { ownerId: s.ownerId, version: s.version, data: JSON.stringify(s) });
  }

  private parse(data: string) {
    return JSON.parse(data) as CheckoutSession;
  }

  async load(ownerId: string, id: string) {
    const r = this.rows.get(id);
    return r && r.ownerId === ownerId ? this.parse(r.data) : null;
  }

  async save(next: CheckoutSession, readVersion: number) {
    const r = this.rows.get(next.id);
    if (!r || r.version !== readVersion) return false;
    this.rows.set(next.id, { ...r, version: next.version, data: JSON.stringify(next) });
    return true;
  }

  async ownerOf(id: string) {
    return this.rows.get(id)?.ownerId ?? null;
  }

  async transfer(id: string, from: string, to: string, now: number) {
    const r = this.rows.get(id);
    if (!r || r.ownerId !== from) return null;
    const s = this.parse(r.data);
    if (s.expiresAt <= now || s.status === 'completed' || s.status === 'canceled') return null;
    const next = { ...s, ownerId: to };
    this.rows.set(id, { ...r, ownerId: to, data: JSON.stringify(next) });
    return next;
  }

  async stuckInProgress(before: number, limit: number) {
    return [...this.rows.values()]
      .map((r) => this.parse(r.data))
      .filter((s) => s.status === 'complete_in_progress' && s.updatedAt < before)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, limit);
  }

  async forOrder(orderId: string) {
    for (const r of this.rows.values()) {
      const s = this.parse(r.data);
      if (s.orderId === orderId) return s;
    }
    return null;
  }
}
