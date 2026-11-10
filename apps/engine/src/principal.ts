/**
 * Who is calling. The web app signs the principal header (PRINCIPAL_HEADER) onto each request it
 * forwards: the order page's and the assistant's sockets, `/mcp` and `/a2a`. `forwardedPrincipal`
 * believes it only with a valid signature for that path. Agents keep a socket's principal on the
 * connection and re-read it with `livePrincipal` before acting, so signing out, a password reset,
 * being disabled, a role change, a revoked token or sign-in being turned on applies to a page that
 * is already open.
 */

import * as uc from '@commerceworker/application/commerce';
import {
  type CartGuest,
  type GuestActor,
  PRINCIPAL_HEADER,
  type Principal,
  type ProxiedPrincipal,
  type StaffActor,
  storefrontKeys,
  verifyCartGuest,
  verifyGuestActor,
  verifyPrincipal,
  verifyRpcActor,
} from '@commerceworker/core';
import { identityStore } from './wire';

/** The principal the web app signed onto this request, or null. */
export function forwardedPrincipal(env: Env, request: Request): Promise<ProxiedPrincipal | null> {
  if (!env.PRINCIPAL_KEY) console.error('PRINCIPAL_KEY is not set: refusing forwarded requests');
  return verifyPrincipal(
    [env.PRINCIPAL_KEY, env.PRINCIPAL_KEY_PREVIOUS],
    request.headers.get(PRINCIPAL_HEADER),
    new URL(request.url).pathname,
  );
}

/** Who the web app signed a binding call for (`signRpcActor`, under `PRINCIPAL_KEY`), or null. */
export function rpcActor(env: Env, signed: string, call: string): Promise<StaffActor | null> {
  return verifyRpcActor([env.PRINCIPAL_KEY, env.PRINCIPAL_KEY_PREVIOUS], signed, call);
}

/**
 * The keys the storefront's envelopes are checked under: `storefrontKey` of `PRINCIPAL_KEY`, then
 * of the previous one. The storefront holds these and nothing else, so a staff envelope (a v1
 * principal, a staff actor) is never accepted under them, nor a storefront one under
 * `PRINCIPAL_KEY`.
 */
export function storefrontKeysOf(env: Env): Promise<string[]> {
  return storefrontKeys([env.PRINCIPAL_KEY, env.PRINCIPAL_KEY_PREVIOUS]);
}

/** The buyer the storefront signed for a binding call (`signGuestActor`), or null. */
export async function guestActor(
  env: Env,
  signed: string,
  call: string,
): Promise<GuestActor | null> {
  return verifyGuestActor(await storefrontKeysOf(env), signed, call);
}

/** The external cart's buyer the storefront signed onto this request, or null (see `verifyCartGuest`). */
export async function forwardedGuest(env: Env, request: Request): Promise<CartGuest | null> {
  return verifyCartGuest(
    await storefrontKeysOf(env),
    request.headers.get(PRINCIPAL_HEADER),
    new URL(request.url).pathname,
  );
}

/**
 * A principal as it is now. A person's comes from their live session: null once it has expired or
 * been deleted, or the user is disabled; otherwise with their current role, name and email. Using
 * a socket counts as activity, so it keeps the session from going idle. An API token's is null
 * once it is revoked or expired, and open local dev's once anyone has an account.
 */
export function livePrincipal(
  env: Env,
  p: ProxiedPrincipal,
  /**
   * `touch: false` for a check the person didn't make (a socket re-check, a panel's poll): it
   * reads the session without counting as use, so a page left open still goes idle.
   */
  opts: { touch?: boolean } = {},
): Promise<Principal | null> {
  return uc.livePrincipal({ identity: identityStore(env) }, p, Date.now(), opts);
}

/**
 * Whether whoever is behind `<kind>:<id>` (an A2AAgent's name) may still hear about their orders
 * when no request is open: not a person who has been disabled, nor a token revoked or expired.
 */
export function stillActive(env: Env, kind: string, id: string): Promise<boolean> {
  return uc.stillActive({ identity: identityStore(env) }, kind, id, Date.now());
}

export const SESSION_ENDED = 'Your sign-in has ended. Reload the page to sign in again.';
