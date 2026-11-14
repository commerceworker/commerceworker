/**
 * The catalog's half of CommerceWorker's `products` table (D1): one row per variant SKU, whose name,
 * list price and shipping weight and size the catalog keeps current (a variant without a weight or
 * size clears the row's, so `dim_weight` shipping never bills a size the catalog no longer has).
 * Stock, reservations, cost, reorder settings, seller and kind stay CommerceWorker's own, so the
 * engine's pricing, reservations and replenishment read exactly what they always did.
 *
 * Only one channel feeds it: ORDERS_CHANNEL (default `web`), in BASE_CURRENCY, which is what an
 * order's list prices are in. A variant without a price there isn't written. A product that stops
 * being listed keeps its rows: orders may name its SKUs. Changes can arrive out of order, so a row
 * records when the catalog wrote it (`catalog_at`) and only a newer change applies.
 */
import { BASE_CURRENCY, fromMinor } from '@commerceworker/core';
import {
  type Channel,
  type Product,
  type ProductType,
  pickLocale,
} from '@commerceworker/core/product';
import type { CatalogOrders, CatalogOrderLine as OrderLine } from '@commerceworker/ports/commerce';
import type { ListingChange } from './listings';

/**
 * One variant as an order line sees it, with its per-unit shipping weight (kg) and size (cm): null
 * when the variant has none, so removing them in the catalog clears them here too.
 */
export type { CatalogOrderLine as OrderLine } from '@commerceworker/ports/commerce';

/** The variants of `product` an order can name, priced in BASE_CURRENCY for `channel`. */
export function orderLines(product: Product, type: ProductType, channel: Channel): OrderLine[] {
  if (channel.currency !== BASE_CURRENCY) return [];
  const listing = product.channels[channel.code];
  const fallback = channel.defaultLocale;
  const title = pickLocale(product.title, fallback, fallback) ?? product.key;
  const axes = type.variantAxes.map((code) => type.attributes.find((a) => a.code === code));
  const out: OrderLine[] = [];
  for (const v of product.variants) {
    if (v.status !== 'active') continue;
    const price =
      v.prices?.[channel.code]?.currency === BASE_CURRENCY
        ? v.prices[channel.code]
        : listing?.price?.currency === BASE_CURRENCY
          ? listing.price
          : undefined;
    if (!price) continue;
    const options = axes
      .map((def) => {
        if (!def) return undefined;
        const code = v.attributes[def.code];
        if (typeof code !== 'string') return undefined;
        const label = def.values?.find((x) => x.code === code)?.label;
        return pickLocale(label, fallback, fallback) ?? code;
      })
      .filter((o): o is string => !!o);
    out.push({
      sku: v.sku,
      name: options.length ? `${title} (${options.join(', ')})` : title,
      price: fromMinor(price.amount, BASE_CURRENCY),
      weightKg: v.weightKg ?? null,
      lengthCm: v.dimensionsCm?.length ?? null,
      widthCm: v.dimensionsCm?.width ?? null,
      heightCm: v.dimensionsCm?.height ?? null,
    });
  }
  return out;
}

/** Writes the order lines a batch of changes carries, newest change per SKU winning. */
export async function applyOrders(store: CatalogOrders, changes: ListingChange[]): Promise<void> {
  const latest = new Map<string, { line: OrderLine; at: number }>();
  for (const c of changes)
    for (const line of c.order ?? []) {
      const seen = latest.get(line.sku);
      if (!seen || seen.at < c.at) latest.set(line.sku, { line, at: c.at });
    }
  if (!latest.size) return;
  await store.apply([...latest.values()]);
}
