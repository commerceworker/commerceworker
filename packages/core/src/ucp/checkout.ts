/**
 * The checkout capability (`dev.ucp.shopping.checkout`) and its fulfillment and discount extensions, as a view of
 * the protocol-neutral session (../checkout.ts): what a platform sends becomes a `CheckoutPatch`,
 * and a session becomes the checkout object UCP responses carry. Amounts are integer minor units.
 *
 * Discounts (./discount.ts) carry promotion codes in and the promotions the quote applied out.
 *
 * Fulfillment is shipping, and pickup where the flow offers it (`flowOffersPickup`): a `pickup`
 * method whose destinations are the stores that hold every physical line, selected by id. Shipping:
 * one method covering every line that ships, one destination (the
 * ship-to, `dest_1`) and one group (`fg_1`) whose options are the checkout flow's shipping rates.
 */

import { z } from 'zod';
import type { ShipAddress } from '../address';
import type { CheckoutIssue, CheckoutPatch, CheckoutSession } from '../checkout';
import { isPickup, MAX_CHECKOUT_LINES, MAX_LINE_QUANTITY } from '../checkout';
import { toMinor } from '../money';
import { discountView, MAX_DISCOUNT_CODES } from './discount';
import { UCP_VERSION, ucpMessage } from './errors';
import {
  CHECKOUT_CAPABILITY,
  DISCOUNT_CAPABILITY,
  FULFILLMENT_CAPABILITY,
  responseCapabilities,
  type UcpCapability,
  type UcpPaymentHandler,
  type UcpSettings,
} from './profile';

const str = (max: number) => z.string().max(max);

/** `common/types/postal_address.json`. */
const postalAddress = z
  .object({
    street_address: str(200).optional(),
    extended_address: str(200).optional(),
    address_locality: str(100).optional(),
    address_region: str(100).optional(),
    postal_code: str(20).optional(),
    address_country: str(60).optional(),
    first_name: str(100).optional(),
    last_name: str(100).optional(),
    phone_number: str(40).optional(),
  })
  .passthrough();
type PostalAddress = z.infer<typeof postalAddress>;

const lineItem = z
  .object({
    id: str(40).optional(),
    item: z.object({ id: z.string().min(1).max(100) }).passthrough(),
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  })
  .passthrough();

const buyer = z
  .object({
    email: z.string().email().max(320).optional(),
    first_name: str(100).optional(),
    last_name: str(100).optional(),
    phone_number: str(40).optional(),
  })
  .passthrough();

const fulfillment = z
  .object({
    methods: z
      .array(
        z
          .object({
            id: str(40).optional(),
            type: str(40).optional(),
            destinations: z
              .array(postalAddress.extend({ id: str(40).optional(), type: str(40).optional() }))
              .max(10)
              .optional(),
            selected_destination_id: str(40).nullish(),
            groups: z
              .array(
                z
                  .object({ id: str(40).optional(), selected_option_id: str(80).nullish() })
                  .passthrough(),
              )
              .max(10)
              .optional(),
          })
          .passthrough(),
      )
      .max(5)
      .optional(),
  })
  .passthrough();

/** `shopping/discount.json`'s `discounts_object`, as a request carries it. */
const discounts = z
  .object({ codes: z.array(str(64)).max(MAX_DISCOUNT_CODES).optional() })
  .passthrough();

/** Create and Update Checkout (Update replaces the whole session). */
export const ucpCheckoutInput = z
  .object({
    line_items: z.array(lineItem).min(1).max(MAX_CHECKOUT_LINES),
    buyer: buyer.optional(),
    fulfillment: fulfillment.optional(),
    discounts: discounts.optional(),
  })
  .passthrough();
export type UcpCheckoutInput = z.infer<typeof ucpCheckoutInput>;

/** A payment instrument at Complete Checkout (`common/types/payment_instrument.json`). */
export const ucpInstrument = z
  .object({
    id: z.string().min(1).max(100),
    handler_id: z.string().min(1).max(100),
    type: z.string().min(1).max(40),
    selected: z.boolean().optional(),
    credential: z
      .object({ type: z.string().min(1).max(60), token: z.string().min(1).max(500).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type UcpInstrument = z.infer<typeof ucpInstrument>;

export const ucpCompleteInput = z
  .object({
    payment: z.object({ instruments: z.array(ucpInstrument).min(1).max(5) }).passthrough(),
  })
  .passthrough();

/** The instrument the platform chose: the one marked `selected`, else the only one. */
export function selectedInstrument(input: z.infer<typeof ucpCompleteInput>): UcpInstrument | null {
  const all = input.payment.instruments;
  return all.find((i) => i.selected) ?? (all.length === 1 ? all[0]! : null);
}

export const DESTINATION_ID = 'dest_1';
export const PICKUP_METHOD_ID = 'fm_pickup';
export const SHIPPING_METHOD_ID = 'fm_shipping';
export const SHIPPING_GROUP_ID = 'fg_1';

function fromPostal(a: PostalAddress): Partial<ShipAddress> {
  const name = [a.first_name, a.last_name].filter(Boolean).join(' ');
  const out: Partial<ShipAddress> = {};
  if (name) out.name = name;
  if (a.street_address) out.line1 = a.street_address;
  if (a.extended_address) out.line2 = a.extended_address;
  if (a.address_locality) out.city = a.address_locality;
  if (a.address_region) out.region = a.address_region;
  if (a.postal_code) out.postalCode = a.postal_code;
  if (a.address_country) out.country = a.address_country;
  return out;
}

function toPostal(a: Partial<ShipAddress>): PostalAddress {
  const [first, ...rest] = (a.name ?? '').split(' ').filter(Boolean);
  return {
    ...(a.line1 ? { street_address: a.line1 } : {}),
    ...(a.line2 ? { extended_address: a.line2 } : {}),
    ...(a.city ? { address_locality: a.city } : {}),
    ...(a.region ? { address_region: a.region } : {}),
    ...(a.postalCode ? { postal_code: a.postalCode } : {}),
    ...(a.country ? { address_country: a.country } : {}),
    ...(first ? { first_name: first } : {}),
    ...(rest.length ? { last_name: rest.join(' ') } : {}),
  };
}

/**
 * What a Create or Update Checkout asks for, as a patch over `current`. Update is a full
 * replacement, so whatever the request leaves out is cleared; a destination the platform names by
 * our id (`dest_1`) without resending it keeps the ship-to we hold. Codes are read only when the
 * discount extension is negotiated, and replace the session's (none sent clears them).
 */
export function checkoutPatch(
  input: UcpCheckoutInput,
  current?: CheckoutSession,
  capabilities: ReadonlyMap<UcpCapability, string> = new Map(),
): CheckoutPatch {
  const b = input.buyer;
  const methods = input.fulfillment?.methods;
  // A method is named by the id we gave it, else by its type (which an update may leave out).
  const shipping =
    methods?.find((m) => m.id === SHIPPING_METHOD_ID) ??
    methods?.find((m) => m.id !== PICKUP_METHOD_ID && (!m.type || m.type === 'shipping'));
  let shipTo: Partial<ShipAddress> | null = null;
  if (shipping) {
    const dests = shipping.destinations ?? [];
    const chosen = dests.find((d) => d.id && d.id === shipping.selected_destination_id) ?? dests[0];
    if (chosen) shipTo = fromPostal(chosen);
    else if (shipping.selected_destination_id === DESTINATION_ID) shipTo = current?.shipTo ?? null;
  }
  // A pickup method naming a store replaces shipping: the goods are collected, not sent.
  const pickup = capabilities.has(FULFILLMENT_CAPABILITY)
    ? methods?.find(
        (m) => (m.id === PICKUP_METHOD_ID || m.type === 'pickup') && m.selected_destination_id,
      )
    : undefined;
  const option = shipping?.groups?.find((g) => g.selected_option_id)?.selected_option_id ?? null;
  return {
    lines: input.line_items.map((l) => ({ id: l.id, sku: l.item.id, qty: l.quantity })),
    buyer: {
      ...(b?.email ? { email: b.email } : {}),
      ...(b?.first_name ? { firstName: b.first_name } : {}),
      ...(b?.last_name ? { lastName: b.last_name } : {}),
      ...(b?.phone_number ? { phone: b.phone_number } : {}),
    },
    shipTo: pickup ? null : shipTo,
    shippingOption: pickup ? null : option,
    // Update replaces the whole checkout, so a platform that stops sending the store goes back to shipping.
    ...(capabilities.has(FULFILLMENT_CAPABILITY)
      ? pickup
        ? { fulfillment: 'pickup' as const, pickupLocationId: pickup.selected_destination_id! }
        : { fulfillment: 'ship' as const, pickupLocationId: null }
      : {}),
    ...(capabilities.has(DISCOUNT_CAPABILITY) ? { promoCodes: input.discounts?.codes ?? [] } : {}),
  };
}

/** Everything a checkout response needs beyond the session. */
export type CheckoutView = {
  capabilities: Map<UcpCapability, string>;
  handlers: UcpPaymentHandler[];
  settings: UcpSettings;
  /** The order's page, once completing the checkout placed one. */
  permalink?: string;
};

/** The `ucp.payment_handlers` registry a checkout response carries. */
function handlerRegistry(handlers: UcpPaymentHandler[]) {
  const out: Record<string, Omit<UcpPaymentHandler, 'name'>[]> = {};
  for (const { name, ...h } of handlers) out[name] = [...(out[name] ?? []), h];
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The checkout object for `s`, with its UCP envelope. */
export function toUcpCheckout(s: CheckoutSession, view: CheckoutView) {
  const cur = s.currency;
  const m = (n: number) => toMinor(n, cur);
  const discounted = view.capabilities.has(DISCOUNT_CAPABILITY);
  const disc = discountView(s);
  const priced = new Map(
    (s.quote?.lines ?? []).map((l, i) => [l.id, { ...l, off: disc.lines[i] ?? 0 }]),
  );
  const line_items = s.lines.map((l) => {
    const p = priced.get(l.id);
    // Promotions lower the unit price; with the discount extension the line shows its list price
    // and the discount apart, so the lines add up to the same subtotal as the totals.
    const off = discounted ? (p?.off ?? 0) : 0;
    const price = m(off ? (p?.listPrice ?? p?.unitPrice ?? 0) : (p?.unitPrice ?? 0));
    const total = price * l.qty;
    return {
      id: l.id,
      item: { id: l.sku, title: p?.title ?? l.title ?? l.sku, price },
      quantity: l.qty,
      totals: [
        { type: 'subtotal', amount: total },
        ...(off ? [{ type: 'discount', display_text: 'Discount', amount: -off }] : []),
        { type: 'total', amount: total - off },
      ],
    };
  });
  const q = s.quote;
  const itemsOff = discounted ? disc.items : 0;
  const shippingOff = discounted ? disc.shipping : 0;
  const totals = [
    { type: 'subtotal', display_text: 'Subtotal', amount: m(q?.subtotal ?? 0) + itemsOff },
    ...(itemsOff + shippingOff
      ? [{ type: 'discount', display_text: 'Discount', amount: -(itemsOff + shippingOff) }]
      : []),
    ...(q?.ships
      ? [
          {
            type: 'fulfillment',
            display_text: isPickup(s) ? 'Pickup' : 'Shipping',
            amount: m(q.shipping) + shippingOff,
          },
        ]
      : []),
    { type: 'tax', display_text: 'Tax', amount: m(q?.tax ?? 0) },
    { type: 'total', display_text: 'Total', amount: m(q?.total ?? 0) },
  ];

  const fulfills = view.capabilities.has(FULFILLMENT_CAPABILITY) && q?.ships;
  const shippedIds = (q?.lines ?? []).filter((l) => l.ships).map((l) => l.id);
  const selected = s.shippingOption ?? q?.shippingOption ?? null;
  // The stores the last write found able to take the order (`s.pickupStores`); the one chosen
  // stays listed once nothing qualifies or the checkout is done.
  const stores = fulfills ? (s.pickupStores ?? []) : [];
  const pickupMethod =
    stores.length || isPickup(s)
      ? {
          id: PICKUP_METHOD_ID,
          type: 'pickup',
          line_item_ids: shippedIds,
          destinations: stores.map((st) => ({
            id: st.id,
            type: 'business_location',
            name: st.name,
            ...(st.postalCode ? { address: { postal_code: st.postalCode } } : {}),
          })),
          selected_destination_id: isPickup(s) ? (s.pickupLocationId ?? null) : null,
          // Nothing to choose beyond the store: collecting costs nothing.
          groups: [] as { id: string; line_item_ids: string[]; selected_option_id: null }[],
        }
      : undefined;
  const fulfillmentView = fulfills
    ? {
        methods: [
          {
            id: SHIPPING_METHOD_ID,
            type: 'shipping',
            line_item_ids: shippedIds,
            destinations: s.shipTo
              ? [{ id: DESTINATION_ID, type: 'shipping_address', ...toPostal(s.shipTo) }]
              : [],
            selected_destination_id: s.shipTo ? DESTINATION_ID : null,
            groups: [
              {
                id: SHIPPING_GROUP_ID,
                line_item_ids: shippedIds,
                options: q.shippingOptions.map((o) => ({
                  id: o.id,
                  title: o.title,
                  carrier: o.carrier,
                  totals: [{ type: 'total', amount: m(o.amount) }],
                })),
                selected_option_id: q.shippingOptions.some((o) => o.id === selected)
                  ? selected
                  : null,
              },
            ],
          },
          ...(pickupMethod ? [pickupMethod] : []),
        ],
        available_methods: [
          { type: 'shipping', line_item_ids: shippedIds },
          ...(pickupMethod
            ? [
                {
                  type: 'pickup',
                  line_item_ids: shippedIds,
                  fulfillable_on: 'now',
                  description: stores.length
                    ? `Available for pickup at ${stores.map((st) => st.name).join(', ')}`
                    : 'No store can take every item for pickup right now',
                },
              ]
            : []),
        ],
      }
    : undefined;

  // The discount step's refusals are reported at the code they refer to, not at the quote's own path.
  const messages = discounted
    ? [...s.issues.filter((i) => i.code !== 'promotion'), ...disc.messages]
    : s.issues;
  const done = s.status === 'completed' || s.status === 'canceled';
  return {
    ucp: {
      version: UCP_VERSION,
      status: 'success' as const,
      capabilities: responseCapabilities(view.capabilities, CHECKOUT_CAPABILITY),
      payment_handlers: done ? {} : handlerRegistry(view.handlers),
    },
    id: s.id,
    status: s.status,
    currency: cur,
    line_items,
    ...(Object.keys(s.buyer).length
      ? {
          buyer: {
            ...(s.buyer.email ? { email: s.buyer.email } : {}),
            ...(s.buyer.firstName ? { first_name: s.buyer.firstName } : {}),
            ...(s.buyer.lastName ? { last_name: s.buyer.lastName } : {}),
            ...(s.buyer.phone ? { phone_number: s.buyer.phone } : {}),
          },
        }
      : {}),
    totals,
    links: view.settings.links,
    ...(messages.length ? { messages: messages.map(ucpMessage) } : {}),
    ...(done ? {} : { expires_at: iso(s.expiresAt) }),
    ...(discounted ? { discounts: { codes: disc.codes, applied: disc.applied } } : {}),
    ...(fulfillmentView ? { fulfillment: fulfillmentView } : {}),
    ...(s.orderId && view.permalink
      ? { order: { id: s.orderId, permalink_url: view.permalink } }
      : {}),
  };
}

/**
 * A pickup method that names line items must name every one that ships: the order is picked up
 * whole (it holds one fulfillment method), so a method covering some lines would silently pick up
 * the rest too. A request that names none (create does not) says nothing.
 */
export function pickupLineIssues(
  input: UcpCheckoutInput | undefined,
  s: CheckoutSession,
): CheckoutIssue[] {
  const method = input?.fulfillment?.methods?.find(
    (m) => (m.id === PICKUP_METHOD_ID || m.type === 'pickup') && m.selected_destination_id,
  );
  const named = method?.line_item_ids;
  if (!Array.isArray(named) || !named.length) return [];
  const missing = (s.quote?.lines ?? []).filter((l) => l.ships && !named.includes(l.id));
  return missing.length
    ? [
        {
          kind: 'error',
          code: 'pickup_unavailable',
          content: `Pickup covers every item that ships; line_item_ids must also name ${missing.map((l) => l.id).join(', ')}.`,
          path: '$.fulfillment',
          severity: 'recoverable',
        },
      ]
    : [];
}

/** Issues only UCP raises: goods that ship when the platform can't send an address. */
export function protocolIssues(
  s: CheckoutSession,
  capabilities: Map<UcpCapability, string>,
): CheckoutIssue[] {
  if (s.quote?.ships && !capabilities.has(FULFILLMENT_CAPABILITY))
    return [
      {
        kind: 'error',
        code: 'fulfillment_required',
        content: `These items ship; the platform must support ${FULFILLMENT_CAPABILITY} to send an address.`,
        path: '$.line_items',
        severity: 'unrecoverable',
      },
    ];
  return [];
}
