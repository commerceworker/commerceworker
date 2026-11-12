/**
 * Completing a checkout, the same for every caller: price the session again so the hold is for what
 * the flow will charge, claim it (`complete_in_progress`, so no update can change what is being paid
 * for), place the hold, start the order keyed by the session, and give the hold back if the order
 * can't be placed. The caller says how it pays (`PaymentAuthorizer`) and how its orders are named
 * (`CheckoutCaller`); what the answer looks like and how a refusal is framed stay with it.
 */

import {
  type CheckoutSession,
  type FlowVersion,
  isPickup,
  type OrderPayment,
  type OrderState,
  toMinor,
} from '@commerceworker/core';
import { orderAgent } from '../namespaces';
import { startOrderOnce } from '../orders';
import { orderRecords } from '../wire';
import type { CheckoutCaller } from './caller';
import { type PaymentAuthorizer, releaseHold } from './payments';
import { bump, refresh, save } from './session';

/**
 * The session to show, that another write won the race for it, or (only when the caller named the
 * total its buyer saw) that the price now differs: the session is written priced again and nothing
 * is claimed. `action`: the card needs the buyer's bank, the session stays claimed with the intent
 * recorded, and the client secret is for the buyer's browser only.
 */
export type Completed =
  | { kind: 'session'; session: CheckoutSession }
  | { kind: 'changed'; session: CheckoutSession }
  | { kind: 'action'; session: CheckoutSession; clientSecret: string }
  | { kind: 'raced' };

export type CompleteOptions = {
  /** The total the buyer saw: completing is refused (`changed`) when the price now differs. */
  shownTotal?: number;
  /**
   * The session is already claimed for this payment (a press retried after its answer was lost):
   * it is not priced or claimed again, and the payment goes on from where it stopped.
   */
  resume?: boolean;
  /** Written with the claim: a hosted card payment's token and attempt count. */
  claim?: Pick<CheckoutSession, 'payment'>;
};

const shown = (session: CheckoutSession): Completed => ({ kind: 'session', session });
const raced: Completed = { kind: 'raced' };

/** A refusal the buyer or platform can fix, shown on the session with it ready to complete again. */
const retryable = (code: string, content: string) => ({
  status: 'ready_for_complete' as const,
  issues: [
    { kind: 'error' as const, code, content, path: '$.payment', severity: 'recoverable' as const },
  ],
});

/**
 * Completes `s` (read at `s.version`, neither complete nor canceled).
 *
 * A hosted checkout's buyer pays with their own instrument (its test mode records a payment and
 * takes none). Never on-account, never the customer's credit or saved cards (`customerId` prices a
 * session, it is no authority to charge), unless the operator explicitly allows it. Throws when
 * the processor or the order fails, after opening the session again and releasing the hold.
 */
export async function completeSession(
  env: Env,
  caller: CheckoutCaller,
  flow: FlowVersion,
  s: CheckoutSession,
  payment: PaymentAuthorizer,
  opts: CompleteOptions = {},
): Promise<Completed> {
  let claimed: CheckoutSession;
  if (opts.resume) {
    claimed = s;
  } else {
    // Priced again now: the hold must be for what the flow will charge.
    const fresh = await refresh(env, flow, s, caller);
    if (
      opts.shownTotal !== undefined &&
      fresh.quote &&
      toMinor(fresh.quote.total, fresh.currency) !== toMinor(opts.shownTotal, fresh.currency)
    ) {
      const next = bump(fresh, {});
      return (await save(env, next, s.version)) ? { kind: 'changed', session: next } : raced;
    }
    if (fresh.status !== 'ready_for_complete') {
      const next = bump(fresh, {});
      return (await save(env, next, s.version)) ? shown(next) : raced;
    }

    if (payment.refusal) {
      const next = bump(fresh, retryable(payment.refusal.code, payment.refusal.content));
      return (await save(env, next, s.version)) ? shown(next) : raced;
    }

    // Claim the session: from here no update can change what is being paid for.
    claimed = bump(fresh, { status: 'complete_in_progress', issues: [], ...opts.claim });
    if (!(await save(env, claimed, s.version))) return raced;
  }

  let auth: Awaited<ReturnType<PaymentAuthorizer['authorize']>>;
  try {
    auth = await payment.authorize(claimed);
  } catch (err) {
    // The processor failed, not the card: open the session again so the caller can retry.
    await save(env, bump(claimed, { status: 'ready_for_complete' }), claimed.version);
    throw err;
  }
  if ('action' in auth) {
    const next = bump(claimed, {
      payment: { attempts: 0, ...claimed.payment, intentId: auth.action.intentId },
    });
    return (await save(env, next, claimed.version))
      ? { kind: 'action', session: next, clientSecret: auth.action.clientSecret }
      : raced;
  }
  if (!auth.ok) {
    const next = bump(claimed, { ...retryable(auth.code, auth.content), ...unpaid(claimed) });
    return (await save(env, next, claimed.version)) ? shown(next) : raced;
  }
  return placeOrder(env, caller, flow, claimed, auth.payment);
}

/**
 * What a reopened session keeps of a hosted card payment: its attempt count, and no token or intent
 * (the next press is a new attempt with a new confirmation token). Nothing for a session that never had one.
 */
const unpaid = (s: CheckoutSession): Pick<CheckoutSession, 'payment'> | Record<string, never> =>
  s.payment ? { payment: { attempts: s.payment.attempts } } : {};

/**
 * Starts the order for a claimed session, keyed by the session, adopting `payment` (the hold the
 * caller placed) and marks the session completed. When the order can't be placed the hold is
 * released and the session reopened. Also how a card payment the buyer authenticated, or the sweep
 * found finished, becomes an order.
 */
export async function placeOrder(
  env: Env,
  caller: CheckoutCaller,
  flow: FlowVersion,
  claimed: CheckoutSession,
  payment?: OrderPayment,
): Promise<Completed> {
  const auth = { payment };
  const q = claimed.quote!;
  const name = [claimed.buyer.firstName, claimed.buyer.lastName].filter(Boolean).join(' ');
  const appliedCodes = (q.discounts?.applied ?? []).flatMap((a) =>
    a.code === null ? [] : [a.code],
  );
  const key = `${caller.idempotencyPrefix}:${claimed.id}`;
  let orderId: string;
  try {
    const started = await startOrderOnce(env, {
      flowId: flow.id,
      version: flow.version,
      idempotencyKey: key,
      startedBy: caller.ownerId,
      input: {
        model: flow.model,
        channel: caller.channel,
        externalId: claimed.id,
        ...(claimed.customerId ? { customerId: claimed.customerId } : {}),
        title: `Checkout ${claimed.id}`,
        currency: claimed.currency,
        lines: q.lines.map((l) => ({ sku: l.sku, name: l.title, qty: l.qty })),
        contact: {
          email: claimed.buyer.email!,
          ...(name ? { name } : {}),
          ...(claimed.buyer.phone ? { phone: claimed.buyer.phone } : {}),
        },
        fulfillment: !q.ships
          ? { method: 'digital' }
          : isPickup(claimed)
            ? { method: 'pickup', locationId: claimed.pickupLocationId! }
            : { method: 'ship' },
        ...((claimed.shippingOption ?? q.shippingOption)
          ? { shippingOption: (claimed.shippingOption ?? q.shippingOption)! }
          : {}),
        ...(auth.payment ? { payment: auth.payment } : {}),
        meta: {
          // Only the codes the quote applied: the flow's discount step takes them off again, so
          // the total it authorizes is the one that was held. A code the quote refused isn't
          // handed on, or it could apply now and move the total off the hold. An automatic
          // promotion has no code to hand on; the step applies it again by itself.
          ...(appliedCodes.length ? { promoCodes: appliedCodes } : {}),
          ...(claimed.shipTo ? { shipTo: claimed.shipTo } : {}),
          ...caller.meta,
        },
      },
    });
    if ('mismatch' in started)
      throw new Error('An order already exists for this checkout with other details');
    orderId = started.orderId;
  } catch (err) {
    // An order this session already started (a replay under a flow published since, or a start
    // that failed after it began) is this checkout's order, and may have adopted this very hold:
    // the session is its completion, and nothing is released that the order may be using.
    const existing = await completeFromOrder(env, caller, claimed, auth.payment);
    if (existing) return existing;
    if (auth.payment?.intentId) await releaseHold(env, auth.payment.intentId);
    const next = bump(claimed, {
      ...unpaid(claimed),
      status: 'ready_for_complete',
      issues: [
        {
          kind: 'error',
          code: 'order_failed',
          content: 'The order could not be placed; try again.',
          severity: 'recoverable',
        },
      ],
    });
    await save(env, next, claimed.version);
    throw err;
  }
  const done = bump(claimed, { status: 'completed', orderId, issues: [] });
  return (await save(env, done, claimed.version)) ? shown(done) : raced;
}

/** The intent an order adopted, or undefined when it can't be read (the order is not running yet). */
async function adoptedIntent(env: Env, orderId: string): Promise<string | undefined> {
  try {
    const state = (await orderAgent(env, orderId).snapshot()) as OrderState;
    return state.order?.payment?.intentId ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Completes `claimed` with the order it already started, when there is one (keyed by the session):
 * a replay under a flow published since, a start that failed after it began, or a completion whose
 * save was lost. The order may have adopted this very hold (or captured it), so it is never
 * released here, except when the order is known to have adopted a different one. Null when the
 * session has no order.
 */
export async function completeFromOrder(
  env: Env,
  caller: CheckoutCaller,
  claimed: CheckoutSession,
  payment?: OrderPayment,
): Promise<Completed | null> {
  const existing = await orderRecords(env)
    .byIdempotencyKey(`${caller.idempotencyPrefix}:${claimed.id}`)
    .catch(() => undefined);
  if (!existing) return null;
  const adopted = await adoptedIntent(env, existing.id);
  if (adopted && payment?.intentId && adopted !== payment.intentId)
    await releaseHold(env, payment.intentId);
  const done = bump(claimed, { status: 'completed', orderId: existing.id, issues: [] });
  return (await save(env, done, claimed.version)) ? shown(done) : raced;
}
