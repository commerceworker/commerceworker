/**
 * A shopper's sign-in on the storefront, pure: who a shopper is, the code and link that prove it,
 * and the email that carries them. A shopper is a verified email address, not a `customers` row:
 * whoever can read the mailbox is signed in as it, and the orders an address placed are found by
 * that address (`orders.contact_email`). Guest checkout is unaffected.
 *
 * The engine owns every credential. `startSignIn` mints a six-digit code and a link token and
 * stores only their hashes (the code's an HMAC under a key only the engine holds, since six digits
 * alone fall to a stolen table); redeeming either spends the sign-in once and mints a 32-byte
 * session secret, stored only as its SHA-256. The storefront carries that secret in a cookie and
 * presents it with each call, beside a guest actor it signed for `shopper`: the secret alone is no
 * credential at the engine, nor is the storefront's key without one, and a stored hash presented
 * as a secret matches nothing.
 */

import { z } from 'zod';
import { escapeHtml } from './order-confirmation';
import type { OrderStatus } from './types';

/** How long a code and its link work. */
export const SHOPPER_CODE_TTL_MS = 10 * 60_000;
/** Wrong codes one sign-in allows; the fifth spends it. */
export const SHOPPER_MAX_ATTEMPTS = 5;
/** The soonest an address may be sent another code. */
export const SHOPPER_COOLDOWN_MS = 60_000;
/**
 * Failures count per address across codes, not per code: asking for a new one doesn't reset them
 * (it would hand a guesser five more tries every cooldown). The fifth try in a window spends them,
 * and the address is sent no new code for this long from its last try. The emailed link of the code
 * already sent is not gated by it (`consumeLink` never reads the tries): a shopper locked out of
 * the code can still use the link.
 */
export const SHOPPER_LOCKOUT_MS = 15 * 60_000;
/** Codes one address is sent in a day, so the sender can't be aimed at a mailbox past this. */
export const SHOPPER_DAILY_MAX = 20;
export const SHOPPER_DAY_MS = 86_400_000;
/** How long a signed-in session lasts, from its start: absolute, not extended by use. */
export const SHOPPER_SESSION_TTL_MS = 30 * 86_400_000;
/** A session's last use is written back at most this often. */
export const SHOPPER_TOUCH_MS = 60 * 60_000;

/** What a shopper call's guest actor is signed for (`signGuestActor`'s `call`), and who it names. */
export const SHOPPER_CALL = 'shopper';
export const SHOPPER_GUEST_ID = 'guest:shopper';

/** A session secret or link token as the engine mints one: 32 random bytes, hex. */
export const SHOPPER_SECRET = /^[0-9a-f]{64}$/;
export const SHOPPER_CODE = /^[0-9]{6}$/;

/** The longest an address may be (RFC 5321). */
export const SHOPPER_EMAIL_MAX = 254;

const emailSchema = z.string().email().max(SHOPPER_EMAIL_MAX);

/** A shopper's email as matched everywhere: trimmed and lower-cased; null for anything that isn't one. */
export function shopperEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return emailSchema.safeParse(email).success ? email : null;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** An address with all but its first character and its domain hidden: `p***@example.com`. */
export function maskShopperEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 1 ? '***' : `${email[0]}***${email.slice(at)}`;
}

/** A session secret or a link token: 32 random bytes, hex. */
export const newShopperSecret = () => hex(crypto.getRandomValues(new Uint8Array(32)));

/** A six-digit code, uniform over 000000 to 999999 (a draw above the largest multiple of a million is redrawn). */
export function newShopperCode(): string {
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % 1_000_000);
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return String(buf[0]! % 1_000_000).padStart(6, '0');
}

/** SHA-256 as hex: a session secret's and a link token's stored form. */
export async function hashShopperSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return hex(new Uint8Array(digest));
}

/**
 * A code's stored form: an HMAC under `key` (the engine's `shopperCodeKey`) over the address and
 * the code, so one address's hash is no other's and a copy of the table can't be searched for the
 * code.
 */
export async function hashShopperCode(key: string, email: string, code: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${email}\0${code}`));
  return hex(new Uint8Array(mac));
}

/** The link's address on the storefront: a page that asks before it signs anyone in. */
export const shopperLinkUrl = (origin: string, token: string) =>
  `${origin.replace(/\/+$/, '')}/account/confirm/${token}`;

/** Who is signed in, as the storefront may know them. */
export interface ShopperView {
  readonly email: string;
  /** When this session began. */
  readonly since: number;
  readonly expiresAt: number;
}

/** A redeemed sign-in: the session secret (the storefront sets it as the cookie) and the shopper. */
export interface ShopperSignedIn {
  readonly secret: string;
  readonly email: string;
  readonly expiresAt: number;
}

/**
 * What asking for a code answered. Whether the address has orders is never looked at, so it can't
 * show in the answer: `sent` for any address that is one.
 */
export type ShopperStart =
  | { readonly status: 'sent' }
  /** An earlier code went to this address a moment ago, or it spent its attempts: nothing was sent. */
  | { readonly status: 'wait' }
  | { readonly status: 'invalid' }
  /** This deployment has no Email Sending. */
  | { readonly status: 'unavailable' }
  /** Email Sending refused the message. */
  | { readonly status: 'failed' };

export interface ShopperEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * The sign-in email. Plain text and an HTML part that escapes every value it carries; the code
 * is digits and the link ours, but nothing here is ever interpreted as markup.
 */
export function shopperSignInEmail(code: string, link: string): ShopperEmail {
  const minutes = SHOPPER_CODE_TTL_MS / 60_000;
  const text = [
    `Your sign-in code is ${code}.`,
    '',
    `It works once, for ${minutes} minutes. Or open this link on the device you want to sign in on:`,
    link,
    '',
    'If you didn’t ask for this, you can ignore it: nobody is signed in until the code or link is used.',
  ].join('\n');
  const html = [
    `<p>Your sign-in code is <strong>${escapeHtml(code)}</strong>.</p>`,
    `<p>It works once, for ${minutes} minutes. Or open this link on the device you want to sign in on:</p>`,
    `<p><a href="${escapeHtml(link)}">Confirm sign-in</a></p>`,
    '<p>If you didn’t ask for this, you can ignore it: nobody is signed in until the code or link is used.</p>',
  ].join('\n');
  return { subject: 'Your sign-in code', text, html };
}

/** Orders on a page of the shopper's list. */
export const SHOPPER_ORDERS_PAGE = 20;
/** The newest orders whose ship-to is read for the address list (each is an order agent's state). */
export const SHOPPER_ADDRESS_ORDERS = 10;
/** The most saved addresses the list holds. */
export const SHOPPER_ADDRESS_MAX = 20;

/** One order on a shopper's list: what the list shows, nothing of its lines, timeline or payment. */
export interface ShopperOrderItem {
  readonly id: string;
  readonly ref: string;
  readonly placedAt: number;
  readonly status: OrderStatus;
  readonly currency: string;
  readonly total: number;
}

/** A page of a shopper's orders, newest first; `next` is the cursor of the page after it, if any. */
export interface ShopperOrderPage {
  readonly email: string;
  readonly orders: readonly ShopperOrderItem[];
  readonly next: string | null;
}

/**
 * A place a shopper has shipped to. `order` ones come from their own orders and are the orders'
 * to keep; `book` ones are the address book's, which the shopper may forget. `id` is the engine's,
 * stable between two lists, and widens nothing: every method re-reads the list for the session's
 * email and finds the id in it.
 */
export interface ShopperAddress {
  readonly id: string;
  readonly source: 'order' | 'book';
  readonly name: string | null;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly region: string | null;
  readonly postalCode: string;
  readonly country: string;
  readonly lastUsedAt: number;
}

export interface ShopperAddresses {
  readonly email: string;
  readonly addresses: readonly ShopperAddress[];
}

/** A list cursor: the last order's time and id, which keyset paging continues after. */
export const shopperOrderCursor = (o: { createdAt: number; id: string }) =>
  `${o.createdAt}:${o.id}`;

const CURSOR = /^(\d{1,15}):([A-Za-z0-9_-]{1,100})$/;

/** A cursor as `shopperOrderCursor` makes it; null for anything else. */
export function parseShopperOrderCursor(raw: unknown): { createdAt: number; id: string } | null {
  const m = typeof raw === 'string' ? CURSOR.exec(raw) : null;
  return m ? { createdAt: Number(m[1]), id: m[2]! } : null;
}
