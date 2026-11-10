/**
 * A cart's files and product search as staff reach them, from the Carts page. The shared rules are
 * in `@commerceworker/cart/files`; this Worker supplies who is asking (a signed-in person) and its
 * bindings. An external cart's buyer reaches the same rules from the storefront's own routes, by
 * the cookie their start link set there, never from here.
 */

import type { CartFilesDeps } from '@commerceworker/cart/files';
import type { CartActor } from '@commerceworker/core';
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

export const cartFiles = (): CartFilesDeps => ({ engine: engine(), docs: docs(), signedActor });
