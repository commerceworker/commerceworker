/**
 * The carts index row a cart projects to: what the Carts page and the data subject sweep read
 * without waking every cart. Pure: the CartAgent derives it when a cart's title or status changes
 * and writes it through the cart records port (@commerceworker/ports/commerce).
 */
import type { Cart } from './cart';
import { ERASED } from './erasure';

export type CartIndexRow = {
  id: string;
  flowId: string;
  /** The plugin that opened an external cart, and its own id for the session. */
  pluginId: string | null;
  sessionRef: string | null;
  createdBy: string;
  createdAt: number;
  title: string;
  status: string;
  customerId: string | null;
  orderId: string | null;
  updatedAt: number;
  /** What the gate admits an external cart's buyer by: moved on while they work. */
  expiresAt: number | null;
  /**
   * Who an external cart is for, lower-cased, so a data subject request finds it: '' once erased,
   * null on a staff cart.
   */
  buyerId: string | null;
};

export function cartIndexRow(c: Cart): CartIndexRow {
  return {
    id: c.id,
    flowId: c.flowId,
    pluginId: c.external?.pluginId ?? null,
    sessionRef: c.external?.sessionRef ?? null,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    title: c.title,
    status: c.status,
    customerId: c.customerId,
    orderId: c.orderId,
    updatedAt: c.updatedAt,
    expiresAt: c.external?.expiresAt ?? null,
    buyerId: c.external
      ? c.external.buyer.id === ERASED
        ? ''
        : c.external.buyer.id.toLowerCase()
      : null,
  };
}
