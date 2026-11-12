/**
 * The transactional order-confirmation email, and the receipt page its link opens.
 *
 * `sendOrderConfirmation` mails a buyer once per order: the message is filed in `messages` under
 * the order and the `confirmation` kind (`CONFIRMATION_KIND`), so a repeat finds it and sends
 * nothing once it has gone. The email's link carries a fresh order-view credential, stored only as
 * a hash with an expiry; the stored message keeps the link without it, so the credential lives in
 * the email alone. A deployment with no Email Sending binding sends nothing and says so: the
 * message is recorded unsent with its reason (`messages.error`), where staff can find it.
 *
 * `orderReceipt` answers the storefront's receipt page: the buyer-safe view of an order for a
 * credential that is one of its live ones, and null for anything else, so an unknown order, a wrong
 * credential and an expired one look the same. Time comes in as `now`.
 */
import {
  type BuyerOrderView,
  CONFIRMATION_KIND,
  confirmationEmail,
  ERASED,
  hashOrderViewToken,
  matchesOrderViewToken,
  newOrderViewToken,
  ORDER_VIEW_TTL_MS,
  orderReceiptUrl,
} from '@commerceworker/core';
import type { EmailSender } from '@commerceworker/ports';
import type {
  MessageStore,
  OrderConfirmations,
  OrderViewTokens,
} from '@commerceworker/ports/commerce';

export type OrderConfirmationPorts = {
  readonly orders: OrderConfirmations;
  readonly messages: MessageStore;
  readonly tokens: OrderViewTokens;
  /** Undefined on a deployment with no Email Sending binding. */
  readonly email: EmailSender | undefined;
  /** The storefront's origin, where the receipt link goes. */
  readonly storefrontOrigin: string;
};

export type OrderConfirmationOutcome =
  | { status: 'sent'; messageId: string }
  | { status: 'already_sent'; messageId: string }
  /** No Email Sending binding: recorded unsent, nothing mailed. */
  | { status: 'not_configured'; messageId: string }
  /** The order names no address to write to (or its buyer was erased). */
  | { status: 'no_recipient' }
  | { status: 'unknown_order' }
  /** Email Sending refused or failed; recorded on the message, and a later call tries again. */
  | { status: 'failed'; messageId: string; error: string };

export const NOT_CONFIGURED = 'Email sending is not configured on this deployment';

export async function sendOrderConfirmation(
  ports: OrderConfirmationPorts,
  orderId: string,
  now: number,
): Promise<OrderConfirmationOutcome> {
  const order = await ports.orders.read(orderId);
  if (!order) return { status: 'unknown_order' };
  const existing = await ports.messages.find(orderId, CONFIRMATION_KIND);
  if (existing?.sentAt) return { status: 'already_sent', messageId: existing.messageId };
  if (!order.recipient || existing?.recipient === ERASED) return { status: 'no_recipient' };

  // What is kept has the link without its credential: staff read messages, and the credential
  // shows an order to whoever holds it.
  const kept = confirmationEmail(order.view, orderReceiptUrl(ports.storefrontOrigin, orderId));
  const { messageId } = await ports.messages.send(orderId, CONFIRMATION_KIND, {
    recipient: order.recipient,
    subject: kept.subject,
    body: kept.text,
  });
  if (!ports.email) {
    await ports.messages.markFailed(messageId, NOT_CONFIGURED);
    return { status: 'not_configured', messageId };
  }

  // At most one live credential per order: an earlier attempt's, which never reached anyone, goes.
  await ports.tokens.revoke([orderId]);
  const token = newOrderViewToken();
  await ports.tokens.issue(orderId, await hashOrderViewToken(token), now, now + ORDER_VIEW_TTL_MS);
  const mail = confirmationEmail(
    order.view,
    orderReceiptUrl(ports.storefrontOrigin, orderId, token),
  );
  let result: { delivered: boolean; error?: string };
  try {
    result = await ports.email.send({
      to: [order.recipient],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      idempotencyKey: messageId,
    });
  } catch (err) {
    result = { delivered: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (result.delivered) {
    await ports.messages.markSent(messageId, now);
    return { status: 'sent', messageId };
  }
  // The credential in a message that didn't go reaches no one: take it away.
  await ports.tokens.revoke([orderId]);
  const error = result.error || 'Email sending refused the message';
  await ports.messages.markFailed(messageId, error);
  return { status: 'failed', messageId, error };
}

/** The order as its buyer may see it, for one of its live credentials; null otherwise. */
export async function orderReceipt(
  ports: Pick<OrderConfirmationPorts, 'orders' | 'tokens'>,
  orderId: string,
  credential: string,
  now: number,
): Promise<BuyerOrderView | null> {
  if (typeof orderId !== 'string' || !orderId || orderId.length > 100) return null;
  if (!(await matchesOrderViewToken(credential, await ports.tokens.live(orderId, now))))
    return null;
  return (await ports.orders.read(orderId))?.view ?? null;
}
