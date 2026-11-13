/**
 * What a buyer is told about their order: the buyer-safe view of it (`BuyerOrderView`, what the
 * storefront's receipt page and the confirmation email show), the confirmation email's text, and
 * the order-view credential the email's link carries. Pure: the use-case that sends it is in
 * `@commerceworker/application`, the engine binds the sender.
 *
 * Everything in a message is text. Product titles, names and addresses come from catalogs, carts
 * and buyers, so the plain part carries them as they are and the HTML part escapes every one; no
 * field is ever interpreted as markup.
 */

import { checkAddress } from './address';
import type { OrderState } from './api';
import { money } from './logic';
import type { OrderStatus } from './types';
import { constantTimeEqual } from './webhooks';

/** How the buyer and staff speak of an order: `#` and its last six characters. */
export const orderRef = (id: string) => `#${id.slice(-6)}`;

/** How long a receipt link works: long enough to find the email again, short enough to lapse. */
export const ORDER_VIEW_TTL_MS = 30 * 86_400_000;

/** The kind a confirmation is filed under in `messages`: one per order. */
export const CONFIRMATION_KIND = 'confirmation';

export interface BuyerOrderLine {
  readonly sku: string;
  readonly name: string;
  readonly qty: number;
  readonly unitPrice: number | null;
  readonly lineTotal: number | null;
}

export interface BuyerShipment {
  readonly carrier: string | null;
  readonly tracking: string;
}

/**
 * An order as its buyer may see it: lines, totals, status, where it ships and its tracking. It
 * carries no timeline, audit, notes, flow, vars, `meta` or payment details, so nothing a staff
 * member wrote or a flow computed reaches a page or an email through it.
 */
export interface BuyerOrderView {
  readonly id: string;
  readonly ref: string;
  readonly status: OrderStatus;
  readonly placedAt: number;
  readonly currency: string;
  readonly lines: readonly BuyerOrderLine[];
  readonly subtotal: number;
  readonly shipping: number;
  readonly tax: number;
  readonly total: number;
  /** The address, one printable line each; empty when the order ships nowhere. */
  readonly shipTo: readonly string[];
  readonly shipments: readonly BuyerShipment[];
}

/** `meta.shipTo` (a string, or an address object) as printable lines. */
export function shipToLines(shipTo: unknown): string[] {
  if (typeof shipTo === 'string') return shipTo.trim() ? [shipTo.trim().slice(0, 500)] : [];
  const a = checkAddress(shipTo).address;
  if (!a) return [];
  const place = [a.city, [a.region, a.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [a.name, a.line1, a.line2, place, a.country].filter((l): l is string => !!l);
}

/** The buyer-safe view of an order's state, or null for an order that has none. */
export function buyerOrderView(
  state: Pick<OrderState, 'orderId' | 'status' | 'order'>,
  shipments: readonly BuyerShipment[] = [],
): BuyerOrderView | null {
  const o = state.order;
  if (!o) return null;
  return {
    id: o.id,
    ref: orderRef(o.id),
    status: state.status,
    placedAt: o.createdAt,
    currency: o.currency,
    lines: o.lines.map((l) => ({
      sku: l.sku,
      name: l.name || l.sku,
      qty: l.qty,
      unitPrice: l.unitPrice ?? null,
      lineTotal: l.unitPrice === undefined ? null : money(l.qty * l.unitPrice),
    })),
    subtotal: o.subtotal,
    shipping: o.shipping,
    tax: o.tax,
    total: o.total,
    shipTo: shipToLines(o.meta?.shipTo),
    shipments: shipments.map((s) => ({ carrier: s.carrier, tracking: s.tracking })),
  };
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text for an HTML body or attribute: markup characters become entities. */
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** An amount in the order's currency; an unknown code falls back to the plain number. */
export function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export interface ConfirmationEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * The confirmation email for `view`, linking to `link` (the receipt page with its credential). The
 * plain part is complete on its own; the HTML part is paragraphs and lists with every value
 * escaped, no images, styles or scripts. The subject holds only the order's reference.
 */
export function confirmationEmail(view: BuyerOrderView, link: string): ConfirmationEmail {
  const cash = (n: number) => formatAmount(n, view.currency);
  const lines = view.lines.map(
    (l) => `${l.qty} × ${l.name}${l.lineTotal === null ? '' : ` — ${cash(l.lineTotal)}`}`,
  );
  const totals = [
    ['Subtotal', view.subtotal],
    ...(view.shipping ? [['Shipping', view.shipping] as const] : []),
    ...(view.tax ? [['Tax', view.tax] as const] : []),
    ['Total', view.total],
  ] as const;
  const subject = `Your order ${view.ref} is confirmed`;
  const text = [
    `Thanks for your order ${view.ref}.`,
    '',
    ...lines,
    '',
    ...totals.map(([k, v]) => `${k}: ${cash(v)}`),
    ...(view.shipTo.length ? ['', 'Shipping to:', ...view.shipTo] : []),
    '',
    `View your order: ${link}`,
    '',
  ].join('\n');
  const li = (s: string) => `<li>${escapeHtml(s)}</li>`;
  const html = [
    `<p>Thanks for your order ${escapeHtml(view.ref)}.</p>`,
    `<ul>${lines.map(li).join('')}</ul>`,
    ...totals.map(([k, v]) => `<p>${k}: ${escapeHtml(cash(v))}</p>`),
    ...(view.shipTo.length
      ? [`<p>Shipping to:<br>${view.shipTo.map(escapeHtml).join('<br>')}</p>`]
      : []),
    `<p><a href="${escapeHtml(link)}">View your order</a></p>`,
  ].join('\n');
  return { subject, text, html };
}

/** A fresh order-view credential: 32 random bytes, hex. Only its hash is stored. */
export function newOrderViewToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** What a credential is stored as: its SHA-256, hex. */
export async function hashOrderViewToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether `credential` is one of the order's live credentials. Every stored hash is compared, in
 * constant time, so the time taken says neither which matched nor how much of one.
 */
export async function matchesOrderViewToken(
  credential: unknown,
  liveHashes: readonly string[],
): Promise<boolean> {
  if (typeof credential !== 'string' || !/^[0-9a-f]{64}$/.test(credential)) return false;
  const given = await hashOrderViewToken(credential);
  let match = false;
  for (const h of liveHashes) match = constantTimeEqual(given, h) || match;
  return match;
}

/** `origin` without its trailing slashes, without a backtracking regex. */
const trimSlashes = (origin: string): string => {
  let end = origin.length;
  while (end > 0 && origin.charCodeAt(end - 1) === 47) end -= 1;
  return origin.slice(0, end);
};

/** The receipt page's address for an order, with its credential. */
export const orderReceiptUrl = (origin: string, orderId: string, token?: string) =>
  `${trimSlashes(origin)}/orders/${encodeURIComponent(orderId)}${token ? `?t=${token}` : ''}`;
