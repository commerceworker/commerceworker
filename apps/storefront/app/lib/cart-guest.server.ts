/**
 * The buyer of an external cart (a punchout session) on the storefront. A plugin hands the buyer's
 * system a one-time start link (`/cart/start/<cartId>/<token>`); redeeming it sets a cookie that
 * keeps that buyer on that cart, and nowhere else, until the cart closes. The cookie is its own
 * envelope (`signCartGuestSession`), never a session: it opens no staff page and no other cart,
 * and the admin's host never sees it.
 */

import { type CartGuest, signCartGuestSession, verifyCartGuestSession } from '@commerceworker/core';
import { ANY_HTTPS_FRAMER, EMBED_HEADER } from '@commerceworker/security/csp';
import { data } from 'react-router';
import { signingKey, verifyingKeys } from './principal.server';

/** The cookie `name` carries on `request`, if any. */
function cookie(request: Request, name: string): string | undefined {
  return (request.headers.get('cookie') ?? '')
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

const COOKIE_RE = /^cart_[a-z0-9]+$/;

/**
 * One cookie per cart, so a buyer with two carts open keeps both. Over https, which is every
 * deployment, it is `__Host-ol_<cartId>` and `Secure`: set only by this host with `Path=/` and no
 * `Domain`, so a sibling subdomain can't plant one. Plain http is local development only, where a
 * browser may refuse a `Secure` cookie (WebKit on Linux does on localhost), so there it is
 * `ol_<cartId>`. The name is read by the request's own scheme, so neither stands in for the other.
 */
const secure = (url: string) => new URL(url).protocol === 'https:';
const cookieName = (cartId: string, https: boolean) => `${https ? '__Host-' : ''}ol_${cartId}`;

/**
 * The cookie for a redeemed start link. `SameSite=None` and `Partitioned` because the buyer's
 * procurement system usually frames the cart (or opens it from its own page), so it is a
 * third-party cookie there, kept in that site's partition.
 */
export async function guestCookie(
  request: Request,
  g: CartGuest,
  expiresAt: number,
): Promise<string> {
  const value = await signCartGuestSession(await signingKey(), g, expiresAt);
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const https = secure(request.url);
  // A non-Secure cookie can't be SameSite=None or Partitioned: plain http dev frames nothing.
  const site = https ? 'Secure; SameSite=None; Partitioned' : 'SameSite=Lax';
  return `${cookieName(g.cartId, https)}=${value}; Path=/; HttpOnly; ${site}; Max-Age=${maxAge}`;
}

/** The buyer this request carries for `cartId`, or null. */
export async function cartGuest(request: Request, cartId: string): Promise<CartGuest | null> {
  if (!COOKIE_RE.test(cartId)) return null;
  const name = cookieName(cartId, secure(request.url));
  return verifyCartGuestSession(await verifyingKeys(), cookie(request, name), cartId);
}

/**
 * Why a buyer can't have a cart page, thrown from its loader and shown by `CartRefusal`. The
 * buyer's system usually frames these pages, so the refusal may be framed by any https page (it
 * holds nothing but the message); otherwise they'd see a blocked frame instead of the reason.
 */
export function cartRefusal(message: string, status: number) {
  return data(message, {
    status,
    headers: {
      'cache-control': 'no-store',
      [EMBED_HEADER]: JSON.stringify({ frameAncestors: [ANY_HTTPS_FRAMER] }),
    },
  });
}
