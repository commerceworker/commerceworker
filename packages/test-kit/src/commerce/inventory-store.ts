/**
 * The inventory port in memory: the same algorithm as the D1 store (packages/db), with a ledger of
 * applied movement ids standing in for its guarded batch. The contract in
 * ./inventory-store-contract.ts holds the two to the same behaviour.
 */
import type { OrderLine, StockLine } from '@commerceworker/core';
import type {
  InventoryStore,
  ProductRecord,
  StockLevel,
  StockRow,
} from '@commerceworker/ports/commerce';

/** What an inventory store holds, as a test seeds it. */
export interface InventoryFixture {
  products?: {
    sku: string;
    stock: number;
    reserved?: number;
    kind?: string;
    reorderPoint?: number;
  }[];
  locationStock?: { locationId: string; sku: string; stock: number; reserved?: number }[];
  /** Shipments by status, for `restoreShipped`. */
  shipments?: { orderId: string; status: string }[];
}

type Level = { stock: number; reserved: number };
type Reservation = {
  orderId: string;
  sku: string;
  qty: number;
  status: 'held' | 'released' | 'consumed' | 'restored';
  locationId?: string;
};

const LIVE_SHIPMENT = new Set(['label_created', 'ready_for_pickup', 'collected']);

export class InMemoryInventoryStore implements InventoryStore {
  private readonly central = new Map<string, Level & { kind: string }>();
  private readonly stores = new Map<string, Level>();
  private readonly reservations = new Map<string, Reservation>();
  /** Movement ids already applied: the ledger that makes every change happen once. */
  private readonly applied = new Set<string>();

  constructor(private readonly fixture: InventoryFixture = {}) {
    for (const p of fixture.products ?? [])
      this.central.set(p.sku, {
        stock: p.stock,
        reserved: p.reserved ?? 0,
        kind: p.kind ?? 'physical',
      });
    for (const s of fixture.locationStock ?? [])
      this.stores.set(`${s.locationId}|${s.sku}`, { stock: s.stock, reserved: s.reserved ?? 0 });
  }

  private row(sku: string, locationId?: string): Level | undefined {
    return locationId ? this.stores.get(`${locationId}|${sku}`) : this.central.get(sku);
  }

  /** Applies a movement once: a repeated id changes nothing. */
  private move(
    id: string,
    kind: 'hold' | 'restock' | 'release' | 'consume',
    r: { sku: string; qty: number; locationId?: string },
  ) {
    if (this.applied.has(id)) return false;
    const level = this.row(r.sku, r.locationId);
    if (!level) return false;
    if (kind === 'hold') level.reserved += r.qty;
    if (kind === 'restock') level.stock += r.qty;
    if (kind === 'release') level.reserved = Math.max(0, level.reserved - r.qty);
    if (kind === 'consume') {
      level.stock -= r.qty;
      level.reserved = Math.max(0, level.reserved - r.qty);
    }
    this.applied.add(id);
    return true;
  }

  async levels(skus: readonly string[], locationId?: string) {
    const out = new Map<string, StockLevel>();
    for (const sku of new Set(skus)) {
      const level = this.row(sku, locationId);
      if (level) out.set(sku, { stock: level.stock, reserved: level.reserved });
    }
    return out;
  }

  async reserve(
    order: { id: string; lines: OrderLine[]; fulfillment?: { locationId?: string } | null },
    stepKey: string,
    options: { forceShort?: boolean } = {},
  ) {
    const locationOf = (l: OrderLine) => l.locationId ?? order.fulfillment?.locationId;
    const idFor = (i: number, sku: string) =>
      `res_${order.id}_${stepKey}_${i}_${sku}`.replace(/[^\w-]/g, '_');
    const prefix = idFor(0, '').slice(0, -2);
    const held = [...this.reservations].filter(
      ([, r]) => r.orderId === order.id && r.status === 'held',
    );
    const earlier = held.filter(([id]) => !id.startsWith(prefix));
    if (earlier.length) return { reservationIds: earlier.map(([id]) => id), short: [] };
    const mine = new Set(held.map(([id]) => id));

    const lines = [...order.lines.entries()].filter(
      ([, l]) => this.central.get(l.sku)?.kind !== 'digital',
    );
    const freeAt = (l: OrderLine) => {
      const level = this.row(l.sku, locationOf(l));
      return level ? level.stock - level.reserved : 0;
    };
    // Shortness is judged against stock before this step holds anything, as the D1 store reads it.
    const short = lines
      .filter(([i, l]) => !mine.has(idFor(i, l.sku)) && (options.forceShort || freeAt(l) < l.qty))
      .map(([, l]) => l.sku);

    const reservationIds: string[] = [];
    // Lines that lost their stock between the read and the hold (an earlier line of this order, or
    // another order): short too, but only after every line has been tried, as in the D1 batch.
    const late: string[] = [];
    for (const [i, line] of lines) {
      if (short.includes(line.sku)) continue;
      const id = idFor(i, line.sku);
      const locationId = locationOf(line);
      // Held only while the stock is still free, line by line, as the batch's guards check it.
      if (!this.reservations.has(id)) {
        if (freeAt(line) < line.qty) {
          late.push(line.sku);
          continue;
        }
        this.reservations.set(id, {
          orderId: order.id,
          sku: line.sku,
          qty: line.qty,
          status: 'held',
          locationId,
        });
      }
      this.move(id, 'hold', { sku: line.sku, qty: line.qty, locationId });
      reservationIds.push(id);
    }
    return { reservationIds, short: [...short, ...late] };
  }

  private settle(orderId: string, status: 'released' | 'consumed') {
    const kind = status === 'released' ? 'release' : 'consume';
    let moved = 0;
    for (const [id, r] of this.reservations) {
      if (r.orderId !== orderId || r.status !== 'held') continue;
      r.status = status;
      if (this.move(`${kind}_${id}`, kind, r)) moved++;
    }
    return moved;
  }

  async release(orderId: string) {
    return this.settle(orderId, 'released');
  }

  async consume(orderId: string) {
    return this.settle(orderId, 'consumed');
  }

  async restoreShipped(orderId: string) {
    const live = (this.fixture.shipments ?? []).some(
      (s) => s.orderId === orderId && LIVE_SHIPMENT.has(s.status),
    );
    if (live) return 0;
    const consumed = [...this.reservations].filter(
      ([, r]) => r.orderId === orderId && r.status === 'consumed',
    );
    for (const [id, r] of consumed) {
      r.status = 'restored';
      this.move(`unconsume_${id}`, 'restock', r);
    }
    return consumed.length;
  }

  async belowReorderPoint(): Promise<ProductRecord[]> {
    return (this.fixture.products ?? [])
      .filter((p) => {
        const level = this.central.get(p.sku)!;
        return level.stock - level.reserved <= (p.reorderPoint ?? 0);
      })
      .map((p) => {
        const level = this.central.get(p.sku)!;
        return {
          sku: p.sku,
          name: p.sku,
          price: 1,
          cost: 1,
          stock: level.stock,
          reserved: level.reserved,
          reorderPoint: p.reorderPoint ?? 0,
          reorderQty: 0,
          supplier: '',
          sellerId: null,
          kind: p.kind ?? 'physical',
          catalogAt: null,
          weightKg: null,
          lengthCm: null,
          widthCm: null,
          heightCm: null,
        };
      });
  }

  async stockList(f: { q?: string; belowReorder?: boolean; limit: number }): Promise<StockRow[]> {
    const q = f.q?.toLowerCase();
    return (this.fixture.products ?? [])
      .map((p) => {
        const level = this.central.get(p.sku)!;
        return {
          sku: p.sku,
          name: p.sku,
          stock: level.stock,
          reserved: level.reserved,
          available: level.stock - level.reserved,
          reorderPoint: p.reorderPoint ?? 0,
          supplier: '',
        };
      })
      .filter(
        (r) =>
          (!q || r.sku.toLowerCase().includes(q)) &&
          (!f.belowReorder || r.available <= r.reorderPoint),
      )
      .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
      .slice(0, f.limit);
  }

  async restock(orderId: string, stepKey: string, lines: readonly StockLine[]) {
    for (const [i, l] of lines.entries())
      this.move(`stk_${orderId}_${stepKey}_${i}_${l.sku}`.replace(/[^\w-]/g, '_'), 'restock', l);
  }
}
