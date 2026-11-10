import { env } from 'cloudflare:workers';
import {
  type GuestActor,
  type ProxiedPrincipal,
  type RpcActor,
  type StaffActor,
  signGuestActor,
  signPrincipal,
  signRpcActor,
  storefrontKey,
} from '@commerceworker/core';
import { StorefrontApi } from '../src/storefront-api';

const principalKey = () => (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!;

/** The principal header the web Worker would sign for a request to `path`. */
export const signed = (p: ProxiedPrincipal, path: string) => signPrincipal(principalKey(), p, path);

/**
 * An actor the web Worker would sign for one `EngineRpc` call (`decide:<id>`, `cart:<id>`). It
 * takes a guest too, to show the engine refuses one signed under the principal key.
 */
export const signedActor = (a: RpcActor, call: string) =>
  signRpcActor(principalKey(), a as StaffActor, call);

/** The key the storefront Worker would hold: derived from the principal key. */
export const storefrontSecret = () => storefrontKey(principalKey());

/** A buyer the storefront Worker would sign for one `StorefrontRpc` call (`cart:<id>`). */
export const signedGuest = async (a: GuestActor, call: string) =>
  signGuestActor(await storefrontSecret(), a, call);

/** Whoever the right Worker would sign: staff under the principal key, a buyer under the storefront's. */
export const signedFor = (a: RpcActor, call: string) =>
  a.kind === 'guest' ? signedGuest(a, call) : signedActor(a, call);

/** The entrypoint the storefront Worker is bound to. */
export const storefrontApi = () =>
  new StorefrontApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
