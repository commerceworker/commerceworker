/**
 * Shipping labels with no storage: how an order's shipping lines split into packages (one per
 * place they ship from) and the tracking number a built-in label gets. The engine books them
 * through the shipping port (@commerceworker/ports/commerce), asking a provider plugin for real
 * labels when the node names one.
 */
import { stringHash } from './codes';
import type { LabelPackage } from './plugins';
import type { Order, OrderLine } from './types';

/** A shipment or label id keyed by the step: anything but word characters and `-` becomes `_`. */
export const shipmentKey = (prefix: string, orderId: string, stepKey: string) =>
  `${prefix}_${orderId}_${stepKey}`.replace(/[^\w-]/g, '_');

/**
 * One package per place the lines ship from (the line's own store when routing split the order,
 * else the order's store, else central stock `null`), sorted by place. The first keeps `base` as
 * its ref, so a single-source order books what it always did; the rest are `<base>_2`, `<base>_3`.
 * With no lines there is still one (empty) package.
 */
export function planPackages(
  order: Pick<Order, 'fulfillment'>,
  lines: readonly OrderLine[],
  base: string,
): LabelPackage[] {
  const locationOf = (l: OrderLine) => l.locationId ?? order.fulfillment?.locationId ?? null;
  const from = [...new Set(lines.map(locationOf))].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
  return (from.length ? from : [null]).map((locationId, n) => ({
    ref: n === 0 ? base : `${base}_${n + 1}`,
    locationId,
    lines: lines
      .filter((l) => locationOf(l) === locationId)
      .map((l) => ({ sku: l.sku, qty: l.qty })),
  }));
}

/**
 * A built-in label's tracking number, stable for its id: the carrier, then ten digits for a
 * shipment, or `R` and nine digits for a return.
 */
export function builtInTracking(carrier: string, id: string, kind: 'shipment' | 'return') {
  const digits = Math.abs(stringHash(id)).toString();
  return kind === 'shipment'
    ? `${carrier.toUpperCase()}${digits.padStart(10, '0').slice(0, 10)}`
    : `${carrier.toUpperCase()}R${digits.padStart(9, '0').slice(0, 9)}`;
}
