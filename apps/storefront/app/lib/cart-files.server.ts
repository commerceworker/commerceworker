/**
 * A cart's files and product search as the buyer reaches them. The shared rules are in
 * `@commerceworker/cart/files`; this Worker supplies who is asking (the buyer a cart's start
 * link admitted, by the cookie set for that cart alone) and its bindings. Staff reach the same
 * rules from the admin's own routes.
 */

import type { CartFilesDeps } from '@commerceworker/cart/files';
import type { CartActor } from '@commerceworker/core';
import { cartGuest } from './cart-guest.server';
import { engine } from './env.server';
import { signedActor } from './principal.server';

/** The buyer this request carries for `cartId`, as a cart actor, or null. */
export async function cartBuyer(request: Request, cartId: string): Promise<CartActor | null> {
  const guest = await cartGuest(request, cartId);
  return guest ? { kind: 'guest', id: guest.id, name: guest.name } : null;
}

const notBuyer = { ok: false as const, error: 'This isn’t your cart.' };

/**
 * The engine's `StorefrontApi` with the buyer signed for each call: it stores the file itself (this
 * Worker holds no bucket) and takes the buyer only for the cart they were admitted to.
 */
export const cartFiles = (): CartFilesDeps => ({
  async snapshot(cartId, actor) {
    return actor.kind === 'guest'
      ? engine().cartSnapshot(cartId, await signedActor(actor, `cart:${cartId}`))
      : null;
  },
  async add(cartId, file, actor) {
    if (actor.kind !== 'guest') return notBuyer;
    return engine().addCartFile(cartId, file, await signedActor(actor, `cart:${cartId}`));
  },
  async read(cartId, attachmentId, actor) {
    if (actor.kind !== 'guest') return null;
    return engine().readCartFile(cartId, attachmentId, await signedActor(actor, `cart:${cartId}`));
  },
  async keepOpen(cartId, actor) {
    if (actor.kind === 'guest')
      await engine().keepCartOpen(cartId, await signedActor(actor, `cart:${cartId}`));
  },
  async search(cartId, q, actor) {
    if (actor.kind !== 'guest') return notBuyer;
    return engine().searchCartProducts(cartId, q, await signedActor(actor, `cart:${cartId}`));
  },
});
