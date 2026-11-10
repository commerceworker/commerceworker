import { env } from 'cloudflare:workers';
import {
  type CartGuest,
  DEV_PRINCIPAL_KEY,
  type GuestActor,
  PRINCIPAL_HEADER,
  type SignedActor,
  signCartGuest,
  signGuestActor,
  storefrontKey,
} from '@commerceworker/core';

/**
 * The key this Worker signs with and checks the buyer's cookie under: `storefrontKey`, derived
 * from the deployment's principal key, which this Worker never holds (the deploy writes only the
 * derived key, `scripts/fleet.ts secrets storefront`). The engine derives the same value and
 * checks what the storefront signs under it alone, so a compromise here can speak as a buyer or a
 * UCP platform and never as staff. Local dev (`vite dev`) derives it from the fixed dev key.
 */
export async function signingKey(): Promise<string> {
  const key =
    (env as { STOREFRONT_KEY?: string }).STOREFRONT_KEY ||
    (import.meta.env.DEV ? await storefrontKey(DEV_PRINCIPAL_KEY) : undefined);
  if (!key)
    throw new Error('STOREFRONT_KEY is not set: the engine would refuse every forwarded call');
  return key;
}

/** The keys a buyer's cookie is checked under: the current, then the previous one in a rotation. */
export async function verifyingKeys(): Promise<string[]> {
  const previous = (env as { STOREFRONT_KEY_PREVIOUS?: string }).STOREFRONT_KEY_PREVIOUS;
  return previous ? [await signingKey(), previous] : [await signingKey()];
}

/** The header for an external cart's buyer on that cart's socket (`signCartGuest`). */
export async function setGuestHeader(headers: Headers, g: CartGuest, path: string) {
  headers.set(PRINCIPAL_HEADER, await signCartGuest(await signingKey(), g, path));
}

/**
 * The buyer acting on a `StorefrontRpc` call, signed for that one call (`cart:<cartId>`): the
 * engine takes it from nothing else, and only for the cart that buyer was admitted to.
 */
export async function signedActor(actor: GuestActor, call: string): Promise<SignedActor> {
  return signGuestActor(await signingKey(), actor, call);
}
