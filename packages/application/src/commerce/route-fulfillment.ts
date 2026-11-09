/**
 * Where an order's physical lines come from: central stock first for shipping, then the shipping
 * stores nearest the customer (one store for everything, or a split across sources); for pickup and
 * carry-out, the order's store, which must hold every line. Reads only; holding the stock is its
 * own step. Ranking and allocation are core rules (`rankStores`, `allocateLines`); this use-case
 * gathers what they need through the ports.
 */
import {
  allocateLines,
  type Order,
  rankStores,
  type StockSource,
  shipToPoint,
} from '@commerceworker/core';
import type {
  FulfillmentStore,
  InventoryStore,
  PricingStore,
} from '@commerceworker/ports/commerce';

export type FulfillmentMethod = 'ship' | 'pickup' | 'carry_out';

export type Routing = {
  /** Branches to take: one physical method (or unavailable), plus digital when there are digital lines. */
  branches: string[];
  method: FulfillmentMethod | null;
  locationId?: string;
  locationName?: string;
  /** A split shipment: where each part ships from (`locationId` null is central stock). */
  sources?: { locationId: string | null; name: string; lines: number[] }[];
  reason?: string;
};

export async function routeFulfillment(
  ports: {
    readonly pricing: PricingStore;
    readonly inventory: InventoryStore;
    readonly fulfillment: FulfillmentStore;
  },
  order: Pick<Order, 'lines' | 'fulfillment' | 'meta'>,
  method: FulfillmentMethod,
): Promise<Routing> {
  const products = await ports.pricing.products(order.lines.map((l) => l.sku));
  const kind = new Map(products.map((p) => [p.sku, p.kind]));
  const digital = order.lines.some((l) => kind.get(l.sku) === 'digital');
  // Lines that hold stock, with their index in the order.
  const lines = [...order.lines.entries()].filter(([, l]) => kind.get(l.sku) !== 'digital');
  // The node records this as its output, `branch` included, as it always has.
  const done = (r: Omit<Routing, 'branches'> & { branch: string }): Routing => ({
    ...r,
    branches: [r.branch, ...(digital ? ['digital'] : [])],
  });
  if (!lines.length) return { branches: ['digital'], method: null };

  const skus = lines.map(([, l]) => l.sku);
  const free = async (locationId?: string) => {
    const levels = await ports.inventory.levels(skus, locationId);
    return new Map([...levels].map(([sku, v]) => [sku, v.stock - v.reserved]));
  };
  // Per SKU, not per line: two lines of one SKU draw on the same stock.
  const need = new Map<string, number>();
  for (const [, l] of lines) need.set(l.sku, (need.get(l.sku) ?? 0) + l.qty);
  const covers = (f: Map<string, number>) =>
    [...need].every(([sku, qty]) => (f.get(sku) ?? 0) >= qty);
  const stores = await ports.fulfillment.locations();

  if (method === 'ship') {
    // Central stock first, then the shipping stores nearest the customer.
    const ranked = rankStores(
      stores.filter((s) => s.ships),
      shipToPoint(order),
    );
    // One read per source, all at once; the ranking order is kept.
    const [central, ...perStore] = await Promise.all([free(), ...ranked.map((s) => free(s.id))]);
    const sources: StockSource[] = [
      { id: null, name: 'Warehouse', free: central! },
      ...ranked.map((s, i) => ({ id: s.id, name: s.name, free: perStore[i]! })),
    ];
    const a = allocateLines(
      lines.map(([index, l]) => ({ index, sku: l.sku, qty: l.qty })),
      sources,
    );
    if (a.kind === 'unavailable')
      return done({
        branch: 'unavailable',
        method,
        reason: `No warehouse or store has enough ${a.short.join(', ')}`,
      });
    if (a.kind === 'whole')
      return done({
        branch: 'ship',
        method,
        ...(a.source.id ? { locationId: a.source.id, locationName: a.source.name } : {}),
      });
    const parts = new Map<StockSource, number[]>();
    for (const [index, source] of a.lines) parts.set(source, [...(parts.get(source) ?? []), index]);
    return done({
      branch: 'ship',
      method,
      sources: [...parts].map(([source, idx]) => ({
        locationId: source.id,
        name: source.name,
        lines: idx,
      })),
    });
  }

  const store = stores.find((s) => s.id === order.fulfillment?.locationId);
  if (!store || (method === 'pickup' && !store.pickup))
    return done({
      branch: 'unavailable',
      method,
      reason: store ? `${store.name} does not offer pickup` : 'No store given for the order',
    });
  if (!covers(await free(store.id)))
    return done({
      branch: 'unavailable',
      method,
      reason: `${store.name} does not have every item`,
    });
  return done({ branch: method, method, locationId: store.id, locationName: store.name });
}

/**
 * The customer has the goods (`commerce.handover`): a staged pickup is collected, or a carry-out
 * is recorded, and the stock the order held is spent. Keyed by the step: a retry records nothing
 * more, and consuming spends a hold once.
 */
export async function handOverOrder(
  ports: { readonly fulfillment: FulfillmentStore; readonly inventory: InventoryStore },
  order: Pick<Order, 'id' | 'fulfillment'>,
  stepKey: string,
): Promise<{ collected: 'pickup' | 'carry_out' }> {
  const r = await ports.fulfillment.handOver(order, stepKey);
  // The goods left the store: the held stock is spent.
  await ports.inventory.consume(order.id);
  return r;
}
