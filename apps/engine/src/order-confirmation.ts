/**
 * The engine's entry to the order-confirmation email: `orderConfirmation.send(env, orderId)` mails
 * the buyer once (the use-case, `sendOrderConfirmation` in @commerceworker/application), and
 * `orderConfirmation.receipt` answers the storefront's receipt page. The Workflow calls `send` for an
 * order on the web channel under a `hosted:` idempotency key (reserved: only hosted checkout's
 * `completeHosted` starts one) once its card is authorized, or at completion for a flow with none, so
 * a flow author adds nothing. It never throws: a send that can't go is recorded on the order's
 * message and returned, since an order is not undone for want of mail.
 */

import {
  type OrderConfirmationOutcome,
  orderReceipt,
  sendOrderConfirmation,
} from '@commerceworker/application/commerce';
import { buyerOrderView, type OrderState } from '@commerceworker/core';
import type { EmailSender } from '@commerceworker/ports';
import type { OrderConfirmations } from '@commerceworker/ports/commerce';
import { ops } from './metrics';
import { orderAgent } from './namespaces';
import {
  emailSender,
  messageStore,
  orderRecords,
  orderViewTokens,
  pricingStore,
  shippingStore,
} from './wire';

/**
 * Whether an order's completion confirms it by email: a hosted checkout's order on the web channel.
 * The mark is the order's idempotency key, which only the engine's hosted completion can start an
 * order under (`hosted:` is a reserved prefix); nothing a caller sends in `meta` can set it.
 */
export const confirmsByEmail = (order: { channel: string }, key: string | undefined) =>
  order.channel === 'web' && !!key?.startsWith('hosted:');

/** An order as its buyer sees it, and the address to write to: the customer's, else the order's contact. */
export function confirmations(env: Env): OrderConfirmations {
  return {
    async read(orderId) {
      // An id nothing started is not woken as an agent of its own.
      if (!(await orderRecords(env).exists(orderId))) return null;
      const state = (await orderAgent(env, orderId).snapshot()) as OrderState;
      const shipments = (await shippingStore(env).booked(orderId))
        .filter((s) => s.status !== 'cancelled' && s.tracking)
        .map((s) => ({ carrier: s.carrier || null, tracking: s.tracking }));
      const view = buyerOrderView(state, shipments);
      if (!view || !state.order) return null;
      const customer = await pricingStore(env).customer(state.order.customerId);
      return { view, recipient: customer?.email ?? state.order.contact?.email ?? null };
    },
  };
}

const ports = (env: Env) => ({
  orders: confirmations(env),
  messages: messageStore(env),
  tokens: orderViewTokens(env),
  storefrontOrigin: env.STOREFRONT_ORIGIN,
});

/**
 * The deployment's sender. One that can't be built (a bad `EMAIL_FROM`) is a sender that refuses
 * with why, so the refusal is recorded on the order's message like any other.
 */
export function sender(env: Env): EmailSender | undefined {
  try {
    return emailSender(env);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { send: async () => ({ delivered: false, error }) };
  }
}

export const orderConfirmation = {
  /** Mails the order's confirmation once; a repeat finds it sent and does nothing. */
  async send(env: Env, orderId: string): Promise<OrderConfirmationOutcome> {
    try {
      const outcome = await sendOrderConfirmation(
        { ...ports(env), email: sender(env) },
        orderId,
        Date.now(),
      );
      if (outcome.status === 'failed') ops().failover('email_failed');
      return outcome;
    } catch (err) {
      console.warn('order confirmation failed', err);
      ops().failover('email_failed');
      return {
        status: 'failed',
        messageId: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /** The buyer-safe order for a receipt link's credential, or null. */
  receipt: (env: Env, orderId: string, credential: string) =>
    orderReceipt(ports(env), orderId, credential, Date.now()),
};
