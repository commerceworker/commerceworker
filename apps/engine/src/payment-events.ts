/**
 * Stripe's webhook events, verified by the web app (`POST /api/v1/webhooks/stripe`) and handed over
 * through `EngineRpc.paymentEvent`.
 *
 *   invoice.paid             settle the invoice (./billing), then deliver `payment.received`
 *   payment_intent.canceled  the authorization it held is voided
 *   charge.dispute.created   deliver `payment.disputed` to a node waiting for it
 *   payment_intent.succeeded an authorization captured in Stripe's dashboard is captured in the ledger
 *   refund.created/updated, charge.refunded
 *                            a refund made in Stripe's dashboard is recorded in the ledger
 *
 * The same handler serves the hourly reconciliation (./payment-reconcile), which lists Stripe's events
 * and offers the ones a dropped webhook never delivered.
 *
 * Each event id is claimed in `payment_events` before it is acted on: Stripe redelivers for up to
 * three days, far past the signed-webhook receipts' window, and a repeat does nothing. The claim says
 * `processing` and when; success marks it `done`, and the outcome `retry` or a throw gives it back, so
 * Stripe's next delivery tries again. A claim whose handler died (an evicted isolate, a CPU limit, a
 * deploy cutting over) stays `processing` and is claimable again after `CLAIM_STALE_MS`; until then a
 * second delivery answers `retry` rather than `duplicate`, so neither Stripe nor the reconciliation
 * gives up on an event nobody finished. So a handler may run twice over a partly applied event, and
 * every one is idempotent: settling an invoice, the ledger's capture and refund rows keyed by the
 * event's ids, a cancel, and an order event the agent remembers it delivered.
 *
 * An event that throws is counted. With `poisonAfter` (the reconciliation passes it) the failure that
 * reaches it marks the event `poisoned`: logged once, counted, and a duplicate from then on, so the
 * reconciliation's cursor moves past it. A webhook delivery counts failures but never poisons.
 */

import {
  type ReconcileOutcome,
  reconcileCapture,
  reconcileRefund,
} from '@commerceworker/application/commerce';
import {
  fromMinor,
  type OrderState,
  type PaymentEvent,
  type PaymentEventResult,
  TERMINAL_ORDER_STATUSES,
} from '@commerceworker/core';
import { settleInvoice } from './billing';
import { ops } from './metrics';
import { orderAgent } from './namespaces';
import { markIntentCanceled, orderForIntent, paymentMode } from './payments';
import { paymentEventLog, paymentLedger } from './wire';

const ports = (env: Env) => ({ ledger: paymentLedger(env) });
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The id of an expandable field: `"pi_…"` or `{ id: "pi_…" }`. */
const idOf = (v: unknown) => str(v) ?? str((v as { id?: unknown } | null)?.id);

/** The event types the engine acts on; the reconciliation asks Stripe for exactly these. */
export const HANDLED_EVENT_TYPES = [
  'invoice.paid',
  'payment_intent.canceled',
  'payment_intent.succeeded',
  'charge.dispute.created',
  'charge.refunded',
  'refund.created',
  'refund.updated',
] as const;

/** What a ledger catch-up came to, as an event result; a difference it can't fix is flagged. */
function reconciled(o: ReconcileOutcome): PaymentEventResult {
  if (o.status === 'unknown') return { outcome: 'ignored', reason: 'Not a CommerceWorker payment' };
  if (o.status === 'retry')
    return { outcome: 'retry', orderId: o.orderId, reason: 'Its payment is not captured here yet' };
  if (o.status === 'mismatch')
    return { outcome: 'ignored', orderId: o.orderId, reason: o.reason, mismatch: true };
  return {
    outcome: 'handled',
    orderId: o.orderId,
    ...(o.status === 'known' ? { reason: 'Already in the ledger' } : {}),
  };
}

/** What the handler answers: the public result, and `poisoned` for the reconciliation alone. */
export type HandledEvent = PaymentEventResult & { poisoned?: true };

/** A claim still `processing` after this long belongs to a handler that died. */
export const CLAIM_STALE_MS = 10 * 60_000;

export async function handleStripeEvent(
  env: Env,
  event: PaymentEvent,
  now = Date.now(),
  poisonAfter?: number,
): Promise<HandledEvent> {
  const log = paymentEventLog(env);
  const claim = await log.claim(event.id, 'stripe', event.type, now, CLAIM_STALE_MS);
  if (claim === 'processing')
    return { outcome: 'retry', reason: 'Another delivery is handling this event' };
  if (claim === 'done') return { outcome: 'duplicate' };
  if (claim === 'poisoned') return { outcome: 'duplicate', reason: 'Poisoned' };
  let result: PaymentEventResult;
  try {
    result = await dispatch(env, event);
    if (result.orderId) await log.link(event.id, result.orderId);
  } catch (err) {
    const f = await log.fail(event.id, poisonAfter);
    if (!f.poisoned) throw err;
    console.error(
      JSON.stringify({
        type: 'stripe_event_poisoned',
        event: event.id,
        eventType: event.type,
        failures: f.failures,
      }),
      err,
    );
    ops().reconcileMismatch('poisoned');
    return { outcome: 'ignored', reason: `Poisoned after ${f.failures} failures`, poisoned: true };
  }
  if (result.outcome === 'retry') await log.release(event.id);
  else await log.finish(event.id, result.outcome);
  return result;
}

async function dispatch(env: Env, event: PaymentEvent): Promise<PaymentEventResult> {
  const obj = event.data.object;
  switch (event.type) {
    case 'invoice.paid': {
      const id = str(obj.id);
      if (!id) return { outcome: 'ignored', reason: 'No invoice id' };
      const currency = str(obj.currency)?.toUpperCase();
      const paidMinor = num(obj.amount_paid);
      const settled = await settleInvoice(
        env,
        id,
        paidMinor !== undefined && currency ? fromMinor(paidMinor, currency) : undefined,
      );
      if (!settled) return { outcome: 'ignored', reason: 'Not a CommerceWorker invoice' };
      return deliver(env, settled.row.orderId, 'payment.received', {
        provider: 'stripe',
        invoiceId: id,
        invoiceNumber: settled.row.number,
        amount: settled.row.amount,
        currency: settled.row.currency,
      });
    }
    case 'payment_intent.canceled': {
      const id = str(obj.id);
      if (!id) return { outcome: 'ignored', reason: 'No PaymentIntent id' };
      const orders = await markIntentCanceled(env, id);
      const orderId = orders[0] ?? (await orderForIntent(env, id)) ?? undefined;
      return orderId ? { outcome: 'handled', orderId } : { outcome: 'ignored' };
    }
    case 'charge.dispute.created': {
      const intent = idOf(obj.payment_intent);
      const orderId = intent ? await orderForIntent(env, intent) : null;
      if (!orderId) return { outcome: 'ignored', reason: 'Not a CommerceWorker payment' };
      // Most flows don't wait for a dispute: one with no `payment.disputed` step is told nothing,
      // rather than retried for days. A flow that wants disputes waits on `payment.disputed`, and
      // a dispute that comes before that step opens is held for it.
      const r = await deliver(env, orderId, 'payment.disputed', {
        provider: 'stripe',
        disputeId: str(obj.id),
        amount:
          num(obj.amount) !== undefined && str(obj.currency)
            ? fromMinor(num(obj.amount)!, str(obj.currency)!.toUpperCase())
            : undefined,
        currency: str(obj.currency)?.toUpperCase(),
        reason: str(obj.reason),
      });
      return r.outcome === 'retry' ? { outcome: 'handled', orderId, reason: 'No wait open' } : r;
    }
    case 'payment_intent.succeeded': {
      const id = str(obj.id);
      const received = num(obj.amount_received);
      if (!id || received === undefined)
        return { outcome: 'ignored', reason: 'No PaymentIntent id or amount received' };
      return reconciled(await reconcileCapture(ports(env), id, received));
    }
    case 'refund.created':
    case 'refund.updated': {
      const intent = idOf(obj.payment_intent);
      const id = str(obj.id);
      const amount = num(obj.amount);
      if (!intent || !id || amount === undefined)
        return { outcome: 'ignored', reason: 'Not a PaymentIntent refund with an amount' };
      return reconciled(
        await reconcileRefund(ports(env), intent, {
          id,
          amount,
          status: str(obj.status) ?? '',
          metadata: (obj.metadata as Record<string, string> | null) ?? {},
        }),
      );
    }
    case 'charge.refunded': {
      // A charge names no refunds of its own, so ask which the ledger lacks.
      const intent = idOf(obj.payment_intent);
      if (!intent) return { outcome: 'ignored', reason: 'Not a PaymentIntent charge' };
      const refunds = await paymentMode(env).processor().listRefunds(intent);
      const results: PaymentEventResult[] = [];
      for (const r of refunds)
        results.push(reconciled(await reconcileRefund(ports(env), intent, r)));
      // A refund waiting on its capture releases the event for another try; then one it can't place.
      return (
        results.find((r) => r.outcome === 'retry') ??
        results.find((r) => r.mismatch) ??
        results.find((r) => r.outcome === 'handled' && !r.reason) ??
        results[0] ?? { outcome: 'ignored', reason: 'No refunds' }
      );
    }
    default:
      return { outcome: 'ignored', reason: `Not handled: ${event.type}` };
  }
}

/**
 * Delivers an order event to the node waiting for it. With no wait open, an order still running
 * whose flow waits for it holds it until the wait opens (the invoice node runs before the wait),
 * so Stripe needn't send it again. One that won't wait for it (its flow has no such step, or it
 * holds all it can) is `retry`, as before; a finished order never will.
 */
async function deliver(
  env: Env,
  orderId: string,
  name: string,
  payload: Record<string, unknown>,
): Promise<PaymentEventResult> {
  const agent = orderAgent(env, orderId);
  const state = (await agent.snapshot()) as OrderState;
  if (!state.orderId) return { outcome: 'ignored', orderId, reason: 'Unknown order' };
  const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
  const r = await agent.deliver(name, clean, { hold: true });
  if (r.delivered) return { outcome: 'handled', orderId, delivered: name };
  if ('held' in r && r.held)
    return { outcome: 'handled', orderId, reason: `Held until a step waits for ${name}` };
  if (TERMINAL_ORDER_STATUSES.includes(state.status))
    return { outcome: 'handled', orderId, reason: `Order is ${state.status}` };
  return { outcome: 'retry', orderId, reason: `No node is waiting for ${name} yet` };
}
