/**
 * Where an order's payment comes from. Pure: the engine's payment gateway reads it to decide which
 * Stripe call (if any) an authorize or charge step makes.
 */

import { money } from './logic';
import type { Order } from './types';

/**
 * - `external`: the channel already took the money (`payment.provider = 'external'`).
 * - `offline`: the node's method is not a card Stripe handles (cash, terms, a till's terminal).
 * - `adopt`: the order names a PaymentIntent created elsewhere (a checkout); check it and use it.
 * - `confirm`: the order names a payment method; create and confirm a PaymentIntent with it.
 * - `off_session`: no method on the order, but the customer has one saved; charge it off-session.
 * - `none`: nothing to pay with.
 */
export const PAYMENT_SOURCES = [
  'external',
  'offline',
  'adopt',
  'confirm',
  'off_session',
  'none',
] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

/** `commerce.authorize_payment` methods that never reach a card processor. */
export const OFFLINE_PAYMENT_METHODS = ['card_present', 'cash', 'gift_card', 'ach', 'terms'];

/** A payment method saved on the customer's account (by a `verify` authorization). */
export type SavedPayment = {
  stripeCustomerId?: string | null;
  paymentMethodId?: string | null;
};

export function paymentSource(
  order: Pick<Order, 'payment'>,
  method = 'card',
  saved: SavedPayment = {},
): PaymentSource {
  const p = order.payment;
  if (p?.provider === 'external') return 'external';
  if (OFFLINE_PAYMENT_METHODS.includes(method)) return 'offline';
  if (p?.intentId) return 'adopt';
  if (p?.paymentMethodId) return 'confirm';
  if (saved.paymentMethodId && (p?.stripeCustomerId ?? saved.stripeCustomerId))
    return 'off_session';
  return 'none';
}

// ── The payments ledger's arithmetic ──────────────────────────────────────

/** The fields of a payments ledger row the rules below read. */
export type LedgerPayment = {
  id: string;
  kind: string;
  amount: number;
  status: string;
  ref?: string | null;
  createdAt: number;
  provider?: string | null;
  /** The processor's id for it: a PaymentIntent, or for an invoice payment, maybe the invoice. */
  externalId?: string | null;
};

/** Money captured or charged that stuck. */
export const isPaid = (p: Pick<LedgerPayment, 'kind' | 'status'>) =>
  p.status === 'succeeded' && (p.kind === 'capture' || p.kind === 'charge');

/**
 * A Stripe invoice paid by the PaymentIntent its row names (`pi_…`). One recorded by the
 * invoice's own id (`in_…`: paid in parts or partly out of band, or settled before the intent was
 * recorded) names nothing a refund could reach.
 */
export const isInvoicePaidByIntent = (
  p: Pick<LedgerPayment, 'kind' | 'status' | 'provider' | 'externalId'>,
) =>
  p.kind === 'invoice_payment' &&
  p.status === 'succeeded' &&
  p.provider === 'stripe' &&
  (p.externalId ?? '').startsWith('pi_');

/**
 * The order's payments that hold money a refund can give back: its captures and charges, or, on
 * an order paid only by invoice, its invoices paid by a PaymentIntent. An order with both (a
 * capture "on terms" and the Stripe invoice that then collected it, say) counts only the capture,
 * so the same money is never counted twice; its invoice is refunded in Stripe's dashboard.
 */
export function paidPayments<P extends LedgerPayment>(rows: readonly P[]): P[] {
  const paid = rows.filter(isPaid);
  return paid.length ? paid : rows.filter(isInvoicePaidByIntent);
}

/** A refund that went through. */
export const isRefund = (p: Pick<LedgerPayment, 'kind' | 'status'>) =>
  p.kind === 'refund' && p.status === 'succeeded';

const total = (rows: readonly Pick<LedgerPayment, 'amount'>[]) =>
  rows.reduce((s, p) => s + p.amount, 0);

/** Captured and charged on the order (or paid by invoice, see `paidPayments`), before refunds. */
export const paidTotal = (rows: readonly LedgerPayment[]) => money(total(paidPayments(rows)));

/** Refunded on the order so far. */
export const refundedTotal = (rows: readonly LedgerPayment[]) =>
  money(total(rows.filter(isRefund)));

/** What can still be refunded. */
export const refundableTotal = (rows: readonly LedgerPayment[]) =>
  money(paidTotal(rows) - refundedTotal(rows));

/**
 * How a refund of up to `requested` (everything refundable when omitted) is spread over the
 * payments: newest first, each giving back what it still holds. Refunds that name no payment
 * (`ref`) come off the newest first. `rows` must leave out the refund's own parts, so a retry plans
 * exactly what it did before.
 */
export function planRefund<P extends LedgerPayment>(
  rows: readonly P[],
  requested?: number,
): { payment: P; amount: number }[] {
  const paid = paidPayments(rows).sort(
    (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  );
  const refunds = rows.filter(isRefund);
  const refundable = money(total(paid) - total(refunds));
  let left = money(Math.min(requested ?? refundable, refundable));
  if (left <= 0) return [];
  let unattributed = total(refunds.filter((r) => !paid.some((p) => p.id === r.ref)));
  const plan: { payment: P; amount: number }[] = [];
  for (const p of paid) {
    let room = money(p.amount - total(refunds.filter((r) => r.ref === p.id)));
    const taken = Math.min(room, unattributed);
    room = money(room - taken);
    unattributed = money(unattributed - taken);
    const amount = money(Math.min(room, left));
    if (amount <= 0) continue;
    plan.push({ payment: p, amount });
    left = money(left - amount);
    if (left <= 0) break;
  }
  return plan;
}
