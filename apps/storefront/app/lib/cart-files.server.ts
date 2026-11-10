/**
 * A cart's files and product search as the buyer reaches them. The shared rules are in
 * `@commerceworker/cart/files`; this Worker supplies who is asking (the buyer a cart's start
 * link admitted, by the cookie set for that cart alone) and its bindings. Staff reach the same
 * rules from the admin's own routes.
 */

import type { CartFilesDeps } from '@commerceworker/cart/files';
import type { CartActor } from '@commerceworker/core';
import { cartGuest } from './cart-guest.server';
import { docs, engine } from './env.server';
import { signedActor } from './principal.server';

/** The buyer this request carries for `cartId`, as a cart actor, or null. */
export async function cartBuyer(request: Request, cartId: string): Promise<CartActor | null> {
  const guest = await cartGuest(request, cartId);
  return guest ? { kind: 'guest', id: guest.id, name: guest.name } : null;
}

export const cartFiles = (): CartFilesDeps => ({ engine: engine(), docs: docs(), signedActor });
