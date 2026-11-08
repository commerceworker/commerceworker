/**
 * Booking shipments and return labels, and voiding labels on a rollback, a cancel or the daily
 * retry. Packages and built-in tracking are core rules (`planPackages`, `builtInTracking`); a
 * provider's labels come through `LabelService`, and every outcome is recorded through
 * `ShippingStore`, keyed by the step, so a retry books nothing more.
 */
import {
  builtInTracking,
  type LabelPackage,
  type Order,
  planPackages,
  shipmentKey,
} from '@commerceworker/core';
import type {
  BookedShipment,
  InventoryStore,
  LabelCaller,
  LabelService,
  PricingStore,
  ProviderLabel,
  ShippingStore,
} from '@commerceworker/ports/commerce';

/** A provider returned no label for a package: the node fails for good. */
export class MissingLabelError extends Error {
  override readonly name = 'MissingLabelError';
}

/** The node's provider, when it names a plugin: who labels the shipment, and the node asking. */
export type LabelProvider = { id: string; nodeId: string; config: Record<string, unknown> };

type ShippingPorts = {
  readonly pricing: PricingStore;
  readonly shipping: ShippingStore;
  readonly labels: LabelService;
};

/** The lines that ship (digital goods don't), in order. */
async function shippingLines(pricing: PricingStore, order: Pick<Order, 'lines'>) {
  const kind = new Map(
    (await pricing.products(order.lines.map((l) => l.sku))).map((p) => [p.sku, p.kind]),
  );
  return order.lines.filter((l) => kind.get(l.sku) !== 'digital');
}

const keyed = (s: string) => s.replace(/[^\w-]/g, '_');

/**
 * Voids labels at their provider and records the outcome: `cancelled`, or `void_failed` (kept for
 * the daily retry) when the provider can't. Never throws. Returns how many failed.
 */
async function voidOrKeep(
  ports: Pick<ShippingPorts, 'shipping' | 'labels'>,
  provider: string,
  orderId: string,
  stepKey: string,
  shipments: BookedShipment[],
): Promise<number> {
  if (!shipments.length) return 0;
  let status: 'cancelled' | 'void_failed' = 'cancelled';
  try {
    await ports.labels.void(
      provider,
      orderId,
      stepKey,
      shipments.map((s) => ({ ref: s.id, id: s.externalId! })),
    );
  } catch (err) {
    console.error(`voiding ${provider} labels for ${orderId}`, err);
    status = 'void_failed';
  }
  await ports.shipping.settleLabels(shipments, status);
  return status === 'void_failed' ? shipments.length : 0;
}

/**
 * Asks the provider for a label per package that has goods in it (none at all: no call). A label
 * for a package it wasn't asked about is voided at once; a package it returns no label for fails
 * the node for good (`MissingLabelError`), after voiding what it did return.
 */
async function providerLabels(
  ports: ShippingPorts,
  by: LabelProvider,
  order: Order,
  stepKey: string,
  kind: 'shipment' | 'return',
  carrier: string,
  packages: LabelPackage[],
): Promise<Map<string, ProviderLabel>> {
  const asked = packages
    .map((p) => ({ ...p, lines: p.lines.filter((l) => l.qty > 0) }))
    .filter((p) => p.lines.length);
  if (!asked.length) return new Map();
  const caller: LabelCaller = { nodeId: by.nodeId, stepKey, config: by.config };
  const labels = await ports.labels.create(by.id, caller, order, {
    kind,
    carrier,
    packages: asked,
  });
  const refs = new Set(asked.map((p) => p.ref));
  const byRef = new Map(labels.filter((l) => refs.has(l.ref)).map((l) => [l.ref, l]));
  const missing = asked.filter((p) => !byRef.has(p.ref)).map((p) => p.ref);
  const extra = labels.filter((l) => !refs.has(l.ref) || byRef.get(l.ref) !== l);
  const unwanted = missing.length ? labels : extra;
  if (unwanted.length)
    await voidOrKeep(
      ports,
      by.id,
      order.id,
      stepKey,
      unwanted.map((l) => ({
        id: keyed(`void_${by.id}_${l.id}`),
        orderId: order.id,
        carrier: l.carrier ?? by.id,
        tracking: l.tracking,
        status: 'cancelled',
        provider: by.id,
        externalId: l.id,
      })),
    );
  if (missing.length)
    throw new MissingLabelError(
      `Shipping labels provider “${by.id}” returned no label for ${missing.join(', ')}`,
    );
  return byRef;
}

/**
 * Books one shipment per place the shipping lines ship from, then consumes the order's held stock.
 * With a provider, each package's label (tracking, carrier) is the provider's, and the shipment
 * records which provider made it and its id, to void it on a rollback or a cancel.
 */
export async function bookShipment(
  ports: ShippingPorts & { readonly inventory: InventoryStore },
  order: Order,
  stepKey: string,
  carrier: string,
  by?: LabelProvider,
) {
  const base = shipmentKey('shp', order.id, stepKey);
  const packages = planPackages(order, await shippingLines(ports.pricing, order), base);
  const labels = by
    ? await providerLabels(ports, by, order, stepKey, 'shipment', carrier, packages)
    : null;
  const rows: BookedShipment[] = packages.map((p) => {
    const label = labels?.get(p.ref);
    return {
      id: p.ref,
      orderId: order.id,
      carrier: label?.carrier ?? carrier,
      tracking: label?.tracking ?? builtInTracking(carrier, p.ref, 'shipment'),
      status: 'label_created',
      provider: label ? by!.id : null,
      externalId: label?.id ?? null,
    };
  });
  await ports.shipping.book(rows);
  await ports.inventory.consume(order.id);
  const out = rows.map((r, i) => ({
    shipmentId: r.id,
    tracking: r.tracking,
    locationId: packages[i]!.locationId,
  }));
  return {
    shipmentId: out[0]!.shipmentId,
    carrier: labels?.get(base)?.carrier ?? carrier,
    tracking: out[0]!.tracking,
    shipments: out,
    ...(labels?.size ? { provider: by!.id } : {}),
  };
}

/** A prepaid return label. Stock comes back with a restock once the goods arrive. */
export async function bookReturnLabel(
  ports: ShippingPorts,
  order: Order,
  stepKey: string,
  carrier: string,
  by?: LabelProvider,
) {
  const id = shipmentKey('rma', order.id, stepKey);
  let label: ProviderLabel | undefined;
  if (by) {
    const lines = await shippingLines(ports.pricing, order);
    const pkg = {
      ref: id,
      locationId: null,
      lines: lines.map((l) => ({ sku: l.sku, qty: l.qty })),
    };
    label = (await providerLabels(ports, by, order, stepKey, 'return', carrier, [pkg])).get(id);
  }
  const tracking = label?.tracking ?? builtInTracking(carrier, id, 'return');
  await ports.shipping.book([
    {
      id,
      orderId: order.id,
      carrier: label?.carrier ?? carrier,
      tracking,
      status: 'return_label',
      provider: label ? by!.id : null,
      externalId: label?.id ?? null,
    },
  ]);
  return {
    rmaId: id,
    carrier: label?.carrier ?? carrier,
    tracking,
    ...(label ? { provider: by!.id } : {}),
  };
}

function byProvider(rows: BookedShipment[]) {
  const m = new Map<string, BookedShipment[]>();
  for (const r of rows) if (r.provider) m.set(r.provider, [...(m.get(r.provider) ?? []), r]);
  return m;
}

/**
 * Rollback of a ship step: voids its provider labels at the provider. Never throws, so the saga's
 * earlier compensations still run; a label that can't be voided is kept as `void_failed` and
 * counted, and its shipment is returned in `kept`. The caller cancels the rest.
 */
export async function voidShipmentLabels(
  ports: Pick<ShippingPorts, 'shipping' | 'labels'>,
  orderId: string,
  stepKey: string,
  ids: readonly string[],
) {
  let voided = 0;
  let failed = 0;
  const kept = new Set<string>();
  if (!ids.length) return { voided, failed, kept };
  for (const [provider, group] of byProvider(await ports.shipping.labelled({ ids }))) {
    const n = await voidOrKeep(ports, provider, orderId, stepKey, group);
    if (n) for (const r of group) kept.add(r.id);
    failed += n;
    voided += group.length - n;
  }
  return { voided, failed, kept };
}

/**
 * On a cancel: voids the order's open provider labels (shipments and return labels) before the
 * rest are cancelled. One a provider can't void is kept as `void_failed` and counted.
 */
export async function voidOpenLabels(
  ports: Pick<ShippingPorts, 'shipping' | 'labels'>,
  orderId: string,
) {
  let voided = 0;
  let failed = 0;
  const open = { orderId, statuses: ['label_created', 'ready_for_pickup', 'return_label'] };
  for (const [provider, group] of byProvider(await ports.shipping.labelled(open))) {
    const n = await voidOrKeep(ports, provider, orderId, 'cancel', group);
    failed += n;
    voided += group.length - n;
  }
  return { voided, failed };
}

/**
 * The daily retry of labels a provider couldn't void: voided now, they become `cancelled`; still
 * failing, they stay `void_failed`.
 */
export async function retryLabelVoids(
  ports: Pick<ShippingPorts, 'shipping' | 'labels'>,
  limit = 200,
) {
  const rows = await ports.shipping.voidFailed(limit);
  let voided = 0;
  for (const [provider, group] of byProvider(rows)) {
    const byOrder = new Map<string, BookedShipment[]>();
    for (const r of group) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
    for (const [orderId, mine] of byOrder)
      voided += mine.length - (await voidOrKeep(ports, provider, orderId, 'retry', mine));
  }
  return { tried: rows.length, voided };
}
