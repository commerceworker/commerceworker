/**
 * The marketplace port in memory, seeded with sellers. The contract in
 * ./marketplace-store-contract.ts holds it to the same behaviour as the D1 store.
 */
import type {
  AcceptedPart,
  MarketplaceStore,
  PayoutRecord,
  SellerOrderDraft,
  SellerPart,
  SellerRecord,
} from '@commerceworker/ports/commerce';

export interface MarketplaceFixture {
  sellers?: SellerRecord[];
}

type Part = { sellerId: string; status: string; subtotal: number; reason: string | null };

const byKey =
  <T>(key: (t: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

export class InMemoryMarketplaceStore implements MarketplaceStore {
  private readonly sellerRows = new Map<string, SellerRecord>();
  /** Parts by order, then seller. */
  private readonly partRows = new Map<string, Map<string, Part>>();
  private readonly payoutRows = new Map<string, PayoutRecord>();

  constructor(fixture: MarketplaceFixture = {}) {
    for (const s of fixture.sellers ?? []) this.sellerRows.set(s.id, s);
  }

  private of(orderId: string) {
    let parts = this.partRows.get(orderId);
    if (!parts) {
      parts = new Map();
      this.partRows.set(orderId, parts);
    }
    return parts;
  }

  private sorted(orderId: string) {
    return [...this.of(orderId).values()].sort(byKey((p) => p.sellerId));
  }

  async sellers(ids: readonly string[]) {
    return [...new Set(ids)].flatMap((id) => {
      const s = this.sellerRows.get(id);
      return s ? [s] : [];
    });
  }

  async openSellerOrders(orderId: string, drafts: readonly SellerOrderDraft[]) {
    const parts = this.of(orderId);
    for (const p of drafts)
      if (!parts.has(p.sellerId))
        parts.set(p.sellerId, {
          sellerId: p.sellerId,
          status: p.status,
          subtotal: p.subtotal,
          reason: null,
        });
  }

  async parts(orderId: string): Promise<SellerPart[]> {
    return this.sorted(orderId).map((p) => ({
      ...p,
      name: this.sellerRows.get(p.sellerId)?.name ?? 'Marketplace',
    }));
  }

  async decide(
    orderId: string,
    sellerId: string,
    decision: 'accepted' | 'rejected',
    reason?: string,
  ) {
    const p = this.of(orderId).get(sellerId);
    if (p?.status === 'pending') Object.assign(p, { status: decision, reason: reason ?? null });
  }

  private move(orderId: string, from: string[], to: Partial<Part>) {
    let n = 0;
    for (const p of this.of(orderId).values())
      if (from.includes(p.status)) {
        Object.assign(p, to);
        n++;
      }
    return n;
  }

  async expire(orderId: string, reason: string) {
    return this.move(orderId, ['pending'], { status: 'rejected', reason });
  }

  async cancel(orderId: string) {
    return this.move(orderId, ['pending', 'accepted'], { status: 'cancelled' });
  }

  async contacts(orderId: string) {
    const rows = this.sorted(orderId).flatMap((p) => {
      const s = this.sellerRows.get(p.sellerId);
      return s ? [{ id: s.id, email: s.email, status: p.status }] : [];
    });
    const pending = rows.filter((r) => r.status === 'pending');
    return (pending.length ? pending : rows.filter((r) => r.status === 'accepted')).map(
      ({ id, email }) => ({ id, email }),
    );
  }

  async acceptedParts(orderId: string): Promise<AcceptedPart[]> {
    return this.sorted(orderId).flatMap((p) => {
      const s = this.sellerRows.get(p.sellerId);
      return s && p.status === 'accepted'
        ? [{ sellerId: p.sellerId, subtotal: p.subtotal, commissionPct: s.commissionPct }]
        : [];
    });
  }

  async schedulePayouts(rows: readonly PayoutRecord[]) {
    for (const r of rows) if (!this.payoutRows.has(r.id)) this.payoutRows.set(r.id, { ...r });
  }

  async reversePayouts(orderId: string) {
    let n = 0;
    for (const [id, r] of this.payoutRows)
      if (r.orderId === orderId && r.status === 'scheduled') {
        this.payoutRows.set(id, { ...r, status: 'reversed' });
        n++;
      }
    return n;
  }

  async payouts(orderId: string) {
    return [...this.payoutRows.values()]
      .filter((r) => r.orderId === orderId)
      .sort(byKey((r) => r.id));
  }
}
