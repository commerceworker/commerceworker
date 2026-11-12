/**
 * What completing a checkout asks of a payment: place the hold the order's authorize node will
 * adopt (`order.payment.intentId`), or say why it can't, and let go of a hold no order took. How the
 * hold is placed belongs to the caller (a UCP platform's instrument, a hosted page's PaymentMethod);
 * that it ends as an `Authorized` or a refusal, and is released when the order fails, belongs here.
 */

import type { CheckoutSession, OrderPayment } from '@commerceworker/core';
import { stripeFor, stripeMode } from '../gateway';
import { StripeError } from '../stripe';

export type Authorized =
  | { ok: true; payment?: OrderPayment }
  | { ok: false; code: string; content: string }
  /**
   * The card needs the buyer's bank before it can be held: the intent is recorded on the session
   * (which stays claimed) and its client secret goes to the buyer's browser, which finishes the
   * step and asks the engine to confirm. Nothing is held yet, and nothing is released.
   */
  | {
      ok: false;
      code: 'requires_action';
      content: string;
      action: { intentId: string; clientSecret: string };
    };

export const declined = (content: string): Authorized => ({
  ok: false,
  code: 'payment_failed',
  content,
});

/**
 * The payment a caller completes with. `refusal` is known before the session is claimed (no usable
 * instrument): the checkout is shown with it and nothing is held. `authorize` places the hold for
 * the claimed session; it throws when the processor fails, not the card.
 */
export type PaymentAuthorizer = {
  refusal: { code: string; content: string } | null;
  authorize: (s: CheckoutSession) => Promise<Authorized>;
};

/** The states of an intent we made that nothing has captured: each can be canceled. */
const RELEASABLE = [
  'requires_capture',
  'requires_action',
  'requires_confirmation',
  'requires_payment_method',
];

/**
 * Releases a hold no order took: the order failed before (or instead of) adopting it, or the buyer
 * never finished authenticating it. Idempotent; an intent already captured or canceled is left alone.
 */
export async function releaseHold(env: Env, intentId: string) {
  if (!stripeMode(env)) return;
  const stripe = stripeFor(env);
  try {
    const pi = await stripe.paymentIntents.retrieve(intentId);
    if (RELEASABLE.includes(pi.status))
      await stripe.paymentIntents.cancel(intentId, {}, `release_${intentId}`);
  } catch (err) {
    if (!(err instanceof StripeError) || err.isRetryable) throw err;
  }
}
