/**
 * The fulfillment port in memory, seeded with stores. The contract in
 * ./fulfillment-store-contract.ts holds it to the same behaviour as the D1 store.
 */
import { entitlementCode, pickupCode } from '@commerceworker/core';
import type {
  DigitalLine,
  EntitlementRecord,
  FulfillmentStore,
  ShipmentRecord,
  StoreLocation,
} from '@commerceworker/ports/commerce';

export interface FulfillmentFixture {
  locations?: StoreLocation[];
}

const keyed = (s: string) => s.replace(/[^\w-]/g, '_');

export class InMemoryFulfillmentStore implements FulfillmentStore {
  private readonly shipmentRows = new Map<string, ShipmentRecord>();
  private readonly entitlementRows = new Map<string, EntitlementRecord>();

  constructor(private readonly fixture: FulfillmentFixture = {}) {}

  async locations() {
    return [...(this.fixture.locations ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  }

  async stagePickup(orderId: string, stepKey: string) {
    const id = keyed(`pkp_${orderId}_${stepKey}`);
    const code = pickupCode(id);
    if (!this.shipmentRows.has(id))
      this.shipmentRows.set(id, {
        id,
        orderId,
        carrier: 'pickup',
        tracking: code,
        status: 'ready_for_pickup',
      });
    return { shipmentId: id, pickupCode: code };
  }

  async handOver(
    order: { id: string; fulfillment?: { locationId?: string } | null },
    stepKey: string,
  ) {
    const mine = [...this.shipmentRows.values()].filter((s) => s.orderId === order.id);
    const staged = mine.filter((s) => s.status === 'ready_for_pickup');
    if (staged.length) {
      for (const s of staged) this.shipmentRows.set(s.id, { ...s, status: 'collected' });
      return { collected: 'pickup' as const };
    }
    if (mine.some((s) => s.carrier === 'pickup' && s.status === 'collected'))
      return { collected: 'pickup' as const };
    const id = keyed(`hnd_${order.id}_${stepKey}`);
    if (!this.shipmentRows.has(id))
      this.shipmentRows.set(id, {
        id,
        orderId: order.id,
        carrier: 'carry_out',
        tracking: order.fulfillment?.locationId ?? 'store',
        status: 'collected',
      });
    return { collected: 'carry_out' as const };
  }

  async issueEntitlements(orderId: string, stepKey: string, lines: readonly DigitalLine[]) {
    const out: { sku: string; code: string }[] = [];
    for (const l of lines)
      for (let n = 0; n < l.qty; n++) {
        const id = keyed(`ent_${orderId}_${stepKey}_${l.index}_${n}`);
        const code = entitlementCode(l.sku, id);
        if (!this.entitlementRows.has(id))
          this.entitlementRows.set(id, { id, orderId, sku: l.sku, code, status: 'issued' });
        out.push({ sku: l.sku, code });
      }
    return out;
  }

  async revokeEntitlements(orderId: string) {
    let n = 0;
    for (const e of this.entitlementRows.values())
      if (e.orderId === orderId && e.status === 'issued') {
        this.entitlementRows.set(e.id, { ...e, status: 'revoked' });
        n++;
      }
    return n;
  }

  async shipments(orderId: string) {
    return [...this.shipmentRows.values()]
      .filter((s) => s.orderId === orderId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async entitlements(orderId: string) {
    return [...this.entitlementRows.values()]
      .filter((e) => e.orderId === orderId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
