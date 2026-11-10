/**
 * A cart's files and product search as staff reach them, from the Carts page. The shared rules are
 * in `@commerceworker/cart/files`; this Worker supplies who is asking (a signed-in person) and its
 * bindings. An external cart's buyer reaches the same rules from the storefront's own routes, by
 * the cookie their start link set there, never from here.
 */

import type { CartFilesDeps } from '@commerceworker/cart/files';
import { type CartActor, cartAttachmentKey } from '@commerceworker/core';
import { principal, setupDue } from './auth.server';
import { docs, engine } from './env.server';
import { signedActor } from './principal.server';

/** The signed-in person asking, as a cart actor, or null. */
export async function cartStaff(request: Request): Promise<CartActor | null> {
  const caller = await principal(request);
  return caller && !setupDue(caller)
    ? { kind: 'staff', id: caller.id, name: caller.name, role: caller.role }
    : null;
}

/** Staff only: an external cart's buyer is the storefront's, never reaches this Worker. */
const staffOnly = { ok: false as const, error: 'Only staff change a cart from here.' };

/**
 * The files in the documents bucket, which this Worker stores itself, and the engine over its
 * binding with the staff member signed for each call (`cart:<cartId>`).
 */
export const cartFiles = (): CartFilesDeps => ({
  snapshot: (cartId) => engine().cartSnapshot(cartId),
  async add(cartId, file, actor) {
    if (actor.kind !== 'staff') return staffOnly;
    const key = cartAttachmentKey(cartId, file.id);
    await docs().put(key, file.body, {
      httpMetadata: { contentType: file.type },
      customMetadata: { cartId, name: file.name },
    });
    const added = await engine().attachToCart(
      cartId,
      { id: file.id, name: file.name, type: file.type, size: file.body.byteLength, key },
      await signedActor(actor, `cart:${cartId}`),
    );
    if (!added.ok) await docs().delete(key);
    return added;
  },
  read: (cartId, attachmentId) => docs().get(cartAttachmentKey(cartId, attachmentId)),
  // Staff's activity isn't the buyer's: nothing to keep open.
  keepOpen: async () => {},
  async search(cartId, q, actor) {
    if (actor.kind !== 'staff') return { ...staffOnly };
    return engine().searchCartProducts(cartId, q, await signedActor(actor, `cart:${cartId}`));
  },
});
