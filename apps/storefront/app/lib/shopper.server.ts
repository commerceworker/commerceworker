/**
 * A shopper on the storefront: signed in by an emailed code or link (`/account`). The engine
 * mints the session secret when a code or link is redeemed (`StorefrontRpc.redeemShopperCode`,
 * `redeemShopperLink`) and keeps only its SHA-256; this Worker carries the secret in an HttpOnly
 * cookie and presents it with each call, beside an actor it signs for `shopper` (`shopperActor`).
 * It mints no credential and stores nothing: its key alone makes no shopper, and the cookie is
 * nothing to any other page or Worker. The cookie is `SameSite=Lax` (a link in an email lands on a
 * page that then posts, same-site), never partitioned, and lasts as long as the session.
 */

import {
  LINK_PATHS,
  SHOPPER_CALL,
  SHOPPER_GUEST_ID,
  SHOPPER_SECRET,
  type ShopperAddresses,
  type ShopperView,
} from '@commerceworker/core';
import { data, redirect } from 'react-router';
import { engine } from './env.server';
import { signedActor, signingKey } from './principal.server';
import { overBudget, RATE_WINDOW_S } from './rate-limit';
import { withTurnstilePolicy } from './turnstile.server';

/**
 * Where signing in may send a shopper on to: only a linking request on this host (the consent page
 * a platform sent them to, `/identity/authorize?…`), as a path and query, never another address. It
 * rides the sign-in's two forms as `next`, so a shopper who had to sign in lands back on the consent.
 */
export function safeNext(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2000 || !raw.startsWith(`${LINK_PATHS.authorize}?`))
    return null;
  try {
    const u = new URL(raw, 'https://shop.invalid');
    return u.origin === 'https://shop.invalid' && u.pathname === LINK_PATHS.authorize
      ? `${u.pathname}${u.search}`
      : null;
  } catch {
    return null;
  }
}

/** The cookie `name` carries on `request`, if any. */
function cookie(request: Request, name: string): string | undefined {
  return (request.headers.get('cookie') ?? '')
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/**
 * The cookie is `__Host-cw_shop` and `Secure` on every host but localhost: set only by this host
 * with `Path=/` and no `Domain`, so a sibling subdomain can't plant one. The unprefixed, non-`Secure`
 * `cw_shop` exists for local development alone (a browser may refuse a `Secure` cookie on localhost,
 * WebKit on Linux does) and is used only on `localhost` and `127.0.0.1`: over plain http on any other
 * host a session is refused (`canSetShopperCookie`), since that cookie could be planted or read by
 * anyone on the path, and is never read.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const secure = (url: string) => new URL(url).protocol === 'https:';
const cookieName = (https: boolean) => `${https ? '__Host-' : ''}cw_shop`;

/** Whether this request's host may carry a shopper's session: https, or local development. */
export function canSetShopperCookie(request: Request): boolean {
  const url = new URL(request.url);
  return secure(request.url) || LOCAL_HOSTS.has(url.hostname);
}

/** The `Set-Cookie` for a redeemed sign-in: the secret, until the session ends. */
export function shopperCookie(request: Request, secret: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const https = secure(request.url);
  return `${cookieName(https)}=${secret}; Path=/; HttpOnly; ${https ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${maxAge}`;
}

/** The `Set-Cookie` that removes it. */
export function clearedShopperCookie(request: Request): string {
  const https = secure(request.url);
  return `${cookieName(https)}=; Path=/; HttpOnly; ${https ? 'Secure; ' : ''}SameSite=Lax; Max-Age=0`;
}

/** The actor this Worker signs for every shopper call: the storefront speaking, no one in particular. */
export const shopperActor = () =>
  signedActor({ kind: 'guest', id: SHOPPER_GUEST_ID, name: 'Shopper' }, SHOPPER_CALL);

/** The secret in the request's cookie, if it is the shape the engine mints. */
export function shopperSecret(request: Request): string | null {
  if (!canSetShopperCookie(request)) return null;
  const secret = cookie(request, cookieName(secure(request.url)));
  return secret && SHOPPER_SECRET.test(secret) ? secret : null;
}

/** Who the request's cookie signs in, from the engine, or null. */
export async function currentShopper(
  request: Request,
): Promise<{ shopper: ShopperView; secret: string } | null> {
  const secret = shopperSecret(request);
  if (!secret) return null;
  const shopper = await engine().shopper(secret, await shopperActor());
  return shopper ? { shopper, secret } : null;
}

/**
 * What every account page sends: never cached or shared, and no Referer to any other origin. It is
 * `same-origin` and not `no-referrer` because a page sent `no-referrer` posts its own plain form with
 * `Origin: null`, which React Router (and the Worker's cross-site check) refuse; the sign-in link's
 * confirm page is exactly such a form, and one that must work without script.
 */
export const PRIVATE_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'same-origin' };

/** Where a signed-out visitor to an account page goes; the stale cookie, if any, is left to expire. */
export const toSignIn = () =>
  redirect('/account/sign-in', { status: 303, headers: PRIVATE_HEADERS });

/**
 * What an account page asks the engine with: the cookie's secret and the actor this Worker signs
 * for `shopper`, or a redirect to sign in when the request has no cookie of the engine's shape. The
 * engine says whether the session is live (each account call answers null without one, and the page
 * then goes to `toSignIn` too); nothing about the shopper is decided here.
 */
export async function accountCall(request: Request) {
  const secret = shopperSecret(request);
  if (!secret) throw toSignIn();
  return { secret, actor: await shopperActor() };
}

/** The cursor a list's next-page link carries (`?after=`), as long as the engine makes one; it parses the rest. */
export function listCursor(request: Request): string | undefined {
  const after = new URL(request.url).searchParams.get('after');
  return after && after.length <= 130 ? after : undefined;
}

/**
 * What a signed-in shopper may fill a hosted checkout with: their address and the places their
 * orders have shipped (`StorefrontRpc.shopperAddresses`, read by the engine from the session's
 * address alone), or null for anyone who isn't signed in. A checkout is never held up by it: an
 * engine that can't answer is no offer.
 */
export async function savedDetails(request: Request): Promise<ShopperAddresses | null> {
  const secret = shopperSecret(request);
  if (!secret) return null;
  try {
    return await engine().shopperAddresses(secret, await shopperActor());
  } catch (err) {
    console.warn('shopper details unavailable', err);
    return null;
  }
}

/**
 * An account page's `headers` export: `PRIVATE_HEADERS` whichever of its loader, action or error
 * boundary answered, with anything a refusal sent of its own (a 429's `Retry-After`), and Turnstile's
 * script allowed where the page uses it. React Router hands a route all three header sets, empty
 * when unused, so choosing one with `??` would pick an empty one.
 */
export function accountHeaders(
  { errorHeaders }: { errorHeaders?: Headers | undefined },
  opts: { turnstile?: boolean } = {},
) {
  const out = new Headers(PRIVATE_HEADERS);
  errorHeaders?.forEach((value, key) => {
    out.set(key, value);
  });
  return opts.turnstile ? withTurnstilePolicy(out) : out;
}

/**
 * An address (or anything else a budget is kept per) as an HMAC under this Worker's key: the
 * limiter's key names no address, and no one without the key can compute one to look for it.
 */
async function budgetKey(who: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(await signingKey()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`shopper\0${who}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The caller's address as Cloudflare reports it; 'unknown' where there is none (local dev). */
export const clientKey = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'unknown';

/**
 * Refuses a caller over either sign-in budget, as the page's own answer (a 429 with `Retry-After`),
 * or returns null to go ahead. `who` is the address (a link has none: its token is 256 bits, so only the client's budget applies): each has its own
 * budget, so one's attempts spend no other's; the caller's client address has one across every address. `what` keeps asking for a
 * code and trying one apart.
 */
export async function signInBudget(
  request: Request,
  what: 'start' | 'code' | 'link' | 'authorize',
  who?: string,
) {
  const limited =
    (await overBudget('SIGNIN_IP_LIMIT', `${what}:${clientKey(request)}`)) ??
    (who === undefined
      ? null
      : await overBudget('SIGNIN_EMAIL_LIMIT', `${what}:${await budgetKey(who)}`));
  if (!limited) return null;
  return data(
    { error: `Too many tries. Wait ${RATE_WINDOW_S} seconds and try again.` },
    { status: 429, headers: { ...PRIVATE_HEADERS, 'retry-after': String(RATE_WINDOW_S) } },
  );
}

/** What a sign-in answers over plain http on a real host, before it spends anything. */
export const insecureRefusal = () =>
  data(
    { error: 'Sign in over a secure (https) connection.' },
    { status: 400, headers: PRIVATE_HEADERS },
  );
