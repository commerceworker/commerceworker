import { env } from 'cloudflare:workers';
import {
  type CartGuest,
  DEV_PRINCIPAL_KEY,
  PRINCIPAL_HEADER,
  type RpcActor,
  type SignedActor,
  signCartGuest,
  signRpcActor,
} from '@commerceworker/core';

/**
 * The key this Worker signs with, the same `PRINCIPAL_KEY` the web Worker and the engine hold; the
 * engine checks every envelope against it. Local dev (`vite dev`) uses a fixed key when none is set.
 */
export function principalKey() {
  const key =
    (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY ||
    (import.meta.env.DEV ? DEV_PRINCIPAL_KEY : undefined);
  if (!key)
    throw new Error('PRINCIPAL_KEY is not set: the engine would refuse every forwarded call');
  return key;
}

/** The header for an external cart's buyer on that cart's socket (`signCartGuest`). */
export async function setGuestHeader(headers: Headers, g: CartGuest, path: string) {
  headers.set(PRINCIPAL_HEADER, await signCartGuest(principalKey(), g, path));
}

/**
 * Who is acting on an `EngineRpc` call, signed for that one call (`cart:<cartId>`): the engine
 * takes it from nothing else.
 */
export function signedActor(actor: RpcActor, call: string): Promise<SignedActor> {
  return signRpcActor(principalKey(), actor, call);
}
