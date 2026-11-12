/**
 * What a signed-in shopper sees of their own account: their orders, one order, and the places they
 * have shipped to (the rules, and why a shopper is a verified address and no account, in core's
 * `shopper.ts`). Each call takes the SHA-256 of the session's secret and re-verifies the session
 * itself, then scopes everything by the session's email and nothing else: no id from the storefront
 * widens it, so an order or an address of another email is answered exactly as one that doesn't
 * exist. Time comes in as `now`.
 *
 * The orders are those placed under the address (`orders.contact_email`), newest first by keyset;
 * an erased order has no address left and so never shows. The addresses are the ship-tos of the
 * newest few of those orders, de-duplicated with the address book's entries for a consumer customer
 * with that email (never a business customer or a company member: those are a business's own).
 * Only the book's entries can be forgotten; the orders' places are the orders' record.
 */
import {
  type BuyerOrderView,
  orderRef,
  parseShopperOrderCursor,
  rememberedAddress,
  SHOPPER_ADDRESS_MAX,
  SHOPPER_ADDRESS_ORDERS,
  SHOPPER_ORDERS_PAGE,
  type ShopperAddress,
  type ShopperAddresses,
  type ShopperOrderPage,
  shopperOrderCursor,
} from '@commerceworker/core';
import type {
  AddressBook,
  OrderConfirmations,
  OrderQueries,
  OrderShipTos,
  ShopperAuth,
} from '@commerceworker/ports/commerce';
import { shopperSession } from './shopper';

export type ShopperAccountPorts = {
  readonly shoppers: ShopperAuth;
  readonly orders: Pick<OrderQueries, 'forContact' | 'placedUnder'>;
  readonly addresses: Pick<AddressBook, 'forConsumer' | 'forgetForConsumer'>;
  /** An order as its buyer sees it. */
  readonly views: OrderConfirmations;
  /** The ship-to an order recorded. */
  readonly shipTos: OrderShipTos;
};

/** The session's email, or null once it ended or expired. */
async function emailOf(
  ports: Pick<ShopperAccountPorts, 'shoppers'>,
  tokenHash: string,
  now: number,
) {
  return (await shopperSession(ports, tokenHash, now))?.email ?? null;
}

/**
 * A page of the shopper's orders, newest first, `SHOPPER_ORDERS_PAGE` at most. `cursor` is the
 * `next` of the page before; one that isn't a cursor starts from the top. Null with no session.
 */
export async function shopperOrders(
  ports: ShopperAccountPorts,
  tokenHash: string,
  cursor: unknown,
  now: number,
): Promise<ShopperOrderPage | null> {
  const email = await emailOf(ports, tokenHash, now);
  if (!email) return null;
  const before = parseShopperOrderCursor(cursor) ?? undefined;
  // One more than a page, to know whether there is another.
  const found = await ports.orders.forContact(email, {
    ...(before ? { before } : {}),
    limit: SHOPPER_ORDERS_PAGE + 1,
  });
  const page = found.slice(0, SHOPPER_ORDERS_PAGE);
  const last = page.at(-1);
  return {
    email,
    orders: page.map((o) => ({
      id: o.id,
      ref: orderRef(o.id),
      placedAt: o.createdAt,
      status: o.status as ShopperOrderPage['orders'][number]['status'],
      currency: o.currency,
      total: o.total,
    })),
    next: found.length > page.length && last ? shopperOrderCursor(last) : null,
  };
}

/**
 * The buyer-safe view of one of the shopper's orders (`BuyerOrderView`: the receipt's own), or null
 * for an order of another address, an erased one, an unknown id and a session that has ended, all
 * alike.
 */
export async function shopperOrder(
  ports: ShopperAccountPorts,
  tokenHash: string,
  orderId: unknown,
  now: number,
): Promise<BuyerOrderView | null> {
  if (typeof orderId !== 'string' || !orderId || orderId.length > 100) return null;
  const email = await emailOf(ports, tokenHash, now);
  if (!email || !(await ports.orders.placedUnder(email, orderId))) return null;
  return (await ports.views.read(orderId))?.view ?? null;
}

const orderPlace = (orderId: string) => `order:${orderId}`;
const bookPlace = (id: string) => `book:${id}`;

/**
 * The shopper's places, most recently used first: the book's entries (which they may forget) and
 * the ship-tos of their newest orders, one for each distinct address (the book's wins).
 */
export async function shopperAddresses(
  ports: ShopperAccountPorts,
  tokenHash: string,
  now: number,
): Promise<ShopperAddresses | null> {
  const email = await emailOf(ports, tokenHash, now);
  if (!email) return null;
  const places = new Map<string, ShopperAddress>();
  for (const b of await ports.addresses.forConsumer(email, SHOPPER_ADDRESS_MAX))
    places.set(b.key, {
      id: bookPlace(b.id),
      source: 'book',
      name: b.name,
      line1: b.line1,
      line2: b.line2,
      city: b.city,
      region: b.region,
      postalCode: b.postalCode,
      country: b.country,
      lastUsedAt: b.lastUsedAt,
    });
  const recent = await ports.orders.forContact(email, { limit: SHOPPER_ADDRESS_ORDERS });
  const shipped = await Promise.all(
    recent.map(async (o) => ({ o, shipTo: await ports.shipTos.read(o.id) })),
  );
  // Newest first, so the first order to ship somewhere names it.
  for (const { o, shipTo } of shipped) {
    const kept = rememberedAddress(shipTo);
    if (!kept || places.has(kept.key)) continue;
    const a = kept.address;
    places.set(kept.key, {
      id: orderPlace(o.id),
      source: 'order',
      name: a.name ?? null,
      line1: a.line1,
      line2: a.line2 ?? null,
      city: a.city,
      region: a.region ?? null,
      postalCode: a.postalCode,
      country: a.country,
      lastUsedAt: o.createdAt,
    });
  }
  const addresses = [...places.values()]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, SHOPPER_ADDRESS_MAX);
  return { email, addresses };
}

/**
 * Forgets one of the shopper's saved places by the id `shopperAddresses` gave. Only the book's
 * entries go (an order's place is its record), only the email's own consumer customers', and a
 * repeat does nothing. True when one was forgotten.
 */
export async function forgetShopperAddress(
  ports: ShopperAccountPorts,
  tokenHash: string,
  id: unknown,
  now: number,
): Promise<boolean> {
  if (typeof id !== 'string' || !id.startsWith('book:') || id.length > 100) return false;
  const email = await emailOf(ports, tokenHash, now);
  return email ? ports.addresses.forgetForConsumer(email, id.slice('book:'.length)) : false;
}
