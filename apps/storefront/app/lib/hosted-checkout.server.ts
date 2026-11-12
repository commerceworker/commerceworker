/**
 * The buyer of a hosted checkout on the storefront. An operator hands the buyer a one-time start
 * link (`/checkout/start/<id>/<token>`); redeeming it makes the engine mint a secret, which this
 * Worker sets as a cookie for that checkout alone. The engine stores only the secret's SHA-256 and
 * hashes what it is given to compare, so each call presents the secret with an actor signed for
 * `checkout:<id>` (`signedActor`): this Worker's key alone mints no buyer, and the cookie is no
 * credential to anything but its own session. The
 * cookie is `SameSite=Lax` and not partitioned, since a hosted checkout is the buyer's own top-level
 * page, never framed.
 */

import {
  type HostedCheckoutSettings,
  hostedCall,
  hostedGuestId,
  hostedHash,
} from '@commerceworker/core';
import { data } from 'react-router';
import { engine } from './env.server';
import { signedActor } from './principal.server';

const SETTINGS_CACHE_MS = 30_000;
let cached: { value: HostedCheckoutSettings; at: number } | null = null;

/**
 * Whether hosted checkout is on and what a buyer may edit (the engine reads them from the
 * workspace's settings). Every checkout page asks and they change rarely, so each isolate keeps
 * what it read for 30 seconds: a change an admin saves reaches the storefront within that time.
 */
export async function storefrontSettings(): Promise<HostedCheckoutSettings> {
  if (cached && Date.now() - cached.at < SETTINGS_CACHE_MS) return cached.value;
  const value = await engine().storefrontSettings();
  cached = { value, at: Date.now() };
  return value;
}
export const forgetStorefrontSettings = () => {
  cached = null;
};

/** The cookie `name` carries on `request`, if any. */
function cookie(request: Request, name: string): string | undefined {
  return (request.headers.get('cookie') ?? '')
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** A cookie value as the engine mints one: 64 hex characters, nothing a header could smuggle. */
const SECRET = /^[0-9a-f]{64}$/;

/**
 * One cookie per checkout. Over https, which is every deployment, it is `__Host-cw_chk_<id>` and
 * `Secure`: set only by this host with `Path=/` and no `Domain`, so a sibling subdomain can't plant
 * one. Plain http is local development only, where a browser may refuse a `Secure` cookie (WebKit
 * on Linux does on localhost), so there it is `cw_chk_<id>`. The name is read by the request's own
 * scheme, so neither stands in for the other.
 */
const secure = (url: string) => new URL(url).protocol === 'https:';
const cookieName = (id: string, https: boolean) => `${https ? '__Host-' : ''}cw_chk_${id}`;

/** The `Set-Cookie` for a redeemed link: the secret, until the session ends. */
export function checkoutCookie(
  request: Request,
  id: string,
  secret: string,
  expiresAt: number,
): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const https = secure(request.url);
  return `${cookieName(id, https)}=${secret}; Path=/; HttpOnly; ${https ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${maxAge}`;
}

/**
 * What identifies the buyer to the engine for `id`: the cookie's secret (the engine hashes it to
 * compare, so what it stores is no credential) and the actor signed for this checkout. `budgetKey`
 * names this cookie's own budget: a request with a wrong cookie spends its own, never the real
 * buyer's.
 */
export async function checkoutBuyer(request: Request, id: string) {
  const secret = cookie(request, cookieName(id, secure(request.url)));
  if (!secret || !SECRET.test(secret)) return null;
  return {
    secret,
    budgetKey: `checkout:${id}:${await hostedHash(secret)}`,
    actor: await signedActor(
      { kind: 'guest', id: hostedGuestId(id), name: 'Buyer' },
      hostedCall(id),
    ),
  };
}

/** What every hosted checkout page sends: never cached or shared, and nothing of it in a Referer. */
export const PRIVATE_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

/**
 * The `headers` export of a hosted checkout route: `PRIVATE_HEADERS` whichever of its loader, action
 * or error boundary answered, with anything a refusal sent of its own (a 429's `Retry-After`). React
 * Router hands a route all three header sets, empty when unused, so choosing one with `??` would pick
 * an empty one and let the page fall to the Worker's `private, no-cache`.
 */
export function privateHeaders({ errorHeaders }: { errorHeaders?: Headers | undefined }) {
  const out = new Headers(PRIVATE_HEADERS);
  errorHeaders?.forEach((value, key) => {
    out.set(key, value);
  });
  return out;
}

/** Why a buyer can't have a checkout page, thrown from its loader and shown by `CheckoutRefusal`. */
export function checkoutRefusal(message: string, status: number) {
  return data(message, { status, headers: PRIVATE_HEADERS });
}
