/**
 * The engine's payment gateway: the payment use-cases (@commerceworker/application/commerce) bound
 * to this deployment's payments ledger and card processor.
 *
 * `PAYMENTS_MODE` picks the processor for new payments. "mock" (the default) only records rows, and
 * `order.meta.simulate` ("payment_decline", "charge_fail") drives failures. "stripe" calls Stripe
 * with `STRIPE_SECRET_KEY`; without a key every payment step fails for good rather than letting an
 * order ship unpaid. An intent left in a state Stripe won't act on where the use-case expects none
 * fails the step for good too, as any request Stripe refuses does.
 */
import { NonRetryableError } from 'cloudflare:workflows';
import * as uc from '@commerceworker/application/commerce';
import type { Order } from '@commerceworker/core';
import { IntentStateError, type PaymentMode } from '@commerceworker/ports/commerce';
import { stripeFor, stripeMode } from './gateway';
import { stripeProcessor } from './stripe-processor';
import { paymentLedger } from './wire';

export type { PaymentPurpose, PaymentResult } from '@commerceworker/application/commerce';

/** Mock or Stripe, read when a payment needs it: an unknown mode or a missing key fails for good. */
export const paymentMode = (env: Env): PaymentMode => ({
  live: () => stripeMode(env),
  processor: () => stripeProcessor(stripeFor(env)),
});

const ports = (env: Env): uc.PaymentPorts => ({
  ledger: paymentLedger(env),
  mode: paymentMode(env),
});

/** An intent in the wrong state where none was expected: Stripe would refuse it again. */
async function settled<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof IntentStateError) throw new NonRetryableError(err.message);
    throw err;
  }
}

export const authorizePayment = (
  env: Env,
  order: Order,
  stepKey: string,
  method: string,
  purpose: uc.PaymentPurpose = 'hold',
) => settled(uc.authorizePayment(ports(env), order, stepKey, method, purpose));

export const voidAuthorizations = (env: Env, orderId: string) =>
  settled(uc.voidAuthorizations(ports(env), orderId));

export const markIntentCanceled = (env: Env, intentId: string) =>
  uc.markIntentCanceled(ports(env), intentId);

export const orderForIntent = (env: Env, intentId: string) =>
  uc.orderForIntent(ports(env), intentId);

export const capturePayment = (env: Env, order: Order, stepKey: string) =>
  settled(uc.capturePayment(ports(env), order, stepKey));

export const charge = (env: Env, order: Order, stepKey: string) =>
  settled(uc.charge(ports(env), order, stepKey));

export const paySupplier = (env: Env, order: Order, stepKey: string) =>
  settled(uc.paySupplier(ports(env), order, stepKey));

export const refund = (env: Env, order: Order, stepKey: string, requested?: number) =>
  settled(uc.refund(ports(env), order, stepKey, requested));

export const refundedAmount = (env: Env, orderId: string) => uc.refundedAmount(ports(env), orderId);

export const paidAmount = (env: Env, orderId: string) => uc.paidAmount(ports(env), orderId);
