/**
 * The shipping port in memory. The contract in ./shipping-store-contract.ts holds it to the same
 * behaviour as the D1 store. `FakeLabelService` stands in for a provider plugin.
 */

import type { Clock } from '@commerceworker/ports';
import type {
  BookedShipment,
  LabelService,
  ProviderLabel,
  ShippingStore,
} from '@commerceworker/ports/commerce';
import { OPEN_SHIPMENT } from '@commerceworker/ports/commerce';

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

type Row = BookedShipment & { createdAt: number };

export class InMemoryShippingStore implements ShippingStore {
  /** In booking order, as `created_at` orders them. */
  private readonly rows = new Map<string, Row>();

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  async book(shipments: readonly BookedShipment[]) {
    const createdAt = this.clock.now().getTime();
    for (const s of shipments) if (!this.rows.has(s.id)) this.rows.set(s.id, { ...s, createdAt });
  }

  async settleLabels(shipments: readonly BookedShipment[], status: 'cancelled' | 'void_failed') {
    const createdAt = this.clock.now().getTime();
    for (const s of shipments)
      this.rows.set(s.id, { ...(this.rows.get(s.id) ?? { ...s, createdAt }), status });
  }

  async labelled(
    where:
      | { readonly ids: readonly string[] }
      | { readonly orderId: string; readonly statuses: readonly string[] },
  ) {
    return [...this.rows.values()]
      .filter((r) =>
        'ids' in where
          ? where.ids.includes(r.id)
          : r.orderId === where.orderId && where.statuses.includes(r.status),
      )
      .filter((r) => r.provider && r.externalId && r.status !== 'cancelled')
      .sort(byId)
      .map(({ createdAt: _, ...r }) => r);
  }

  async voidFailed(limit: number, provider?: string) {
    return [...this.rows.values()]
      .filter((r) => r.status === 'void_failed' && (!provider || r.provider === provider))
      .slice(0, limit)
      .map(({ createdAt: _, ...r }) => r);
  }

  async cancel(shipmentId: string) {
    const r = this.rows.get(shipmentId);
    if (r) this.rows.set(shipmentId, { ...r, status: 'cancelled' });
  }

  async cancelOpen(orderId: string) {
    let n = 0;
    for (const [id, r] of this.rows)
      if (r.orderId === orderId && (OPEN_SHIPMENT as readonly string[]).includes(r.status)) {
        this.rows.set(id, { ...r, status: 'cancelled' });
        n++;
      }
    return n;
  }

  async booked(orderId: string) {
    return [...this.rows.values()].filter((r) => r.orderId === orderId).sort(byId);
  }
}

/**
 * A label provider for tests: labels every package (or what `answer` returns), voids unless
 * `failVoids` is set, and records every call.
 */
export class FakeLabelService implements LabelService {
  readonly created: { providerId: string; refs: string[] }[] = [];
  readonly voided: { providerId: string; stepKey: string; ids: string[] }[] = [];
  failVoids = false;

  constructor(private readonly answer?: (refs: string[]) => ProviderLabel[]) {}

  async create(
    providerId: string,
    _caller: unknown,
    _order: unknown,
    input: { packages: { ref: string }[] },
  ) {
    const refs = input.packages.map((p) => p.ref);
    this.created.push({ providerId, refs });
    return (
      this.answer?.(refs) ??
      refs.map((ref, i) => ({ ref, id: `lbl_${i + 1}`, tracking: `TRK${i + 1}`, carrier: 'fake' }))
    );
  }

  async void(
    providerId: string,
    _orderId: string,
    stepKey: string,
    labels: readonly { ref: string; id: string }[],
  ) {
    if (this.failVoids) throw new Error('provider unavailable');
    this.voided.push({ providerId, stepKey, ids: labels.map((l) => l.id) });
  }
}
