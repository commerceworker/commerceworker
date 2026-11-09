/**
 * The stores a checkout can offer for pickup: only where the checkout flow can fulfil one
 * (`flowOffersPickup`), and only stores that offer pickup and hold every physical line, since the
 * order's Route fulfillment step sends a pickup to its one store and refuses it if that store lacks
 * an item. Stock is read the way that step reads it (free = stock - reserved at the store, the
 * lines of one SKU added up), so a store offered here is one the order can then be routed to.
 * Nothing is held until the order runs. Read on a write (`refresh`) and kept on the session.
 */

import {
  type CheckoutSession,
  type FlowVersion,
  flowOffersPickup,
  type PickupStore,
} from '@commerceworker/core';
import { fulfillmentStore, inventoryStore } from '../wire';

export type PickupCheck = {
  /** Stores that can take the whole order. */
  stores: PickupStore[];
  /** Why the store the buyer chose can't, when it can't. */
  problem: string | null;
};

export async function pickupCheck(
  env: Env,
  flow: FlowVersion,
  s: CheckoutSession,
): Promise<PickupCheck> {
  const lines = (s.quote?.lines ?? []).filter((l) => l.ships);
  const chosen = s.pickupLocationId;
  if (!lines.length) return { stores: [], problem: null };
  if (!flowOffersPickup(flow))
    return {
      stores: [],
      problem: chosen ? "This checkout doesn't offer pickup; ship the items instead." : null,
    };
  const need = new Map<string, number>();
  for (const l of lines) need.set(l.sku, (need.get(l.sku) ?? 0) + l.qty);
  const skus = [...need.keys()];
  const all = await fulfillmentStore(env).locations();
  const stores = all.filter((st) => st.pickup);
  const levels = await Promise.all(stores.map((st) => inventoryStore(env).levels(skus, st.id)));
  const short = new Map<string, string[]>();
  const offered = stores.flatMap((st, i) => {
    const free = levels[i]!;
    const lacking = [...need].filter(([sku, qty]) => {
      const v = free.get(sku);
      return v === undefined || v.stock - v.reserved < qty;
    });
    short.set(
      st.id,
      lacking.map(([sku]) => sku),
    );
    return lacking.length ? [] : [{ id: st.id, name: st.name, postalCode: st.postalCode }];
  });
  let problem: string | null = null;
  if (chosen && !offered.some((st) => st.id === chosen)) {
    const store = all.find((st) => st.id === chosen);
    problem = !store
      ? `${chosen} is not a store.`
      : !store.pickup
        ? `${store.name} does not offer pickup.`
        : `${store.name} does not have enough ${(short.get(chosen) ?? []).join(', ')} for pickup; choose another store or ship the items.`;
  }
  return { stores: offered, problem };
}
