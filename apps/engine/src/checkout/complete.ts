/**
 * Completing a checkout, the same for every caller: price the session again so the hold is for what
 * the flow will charge, claim it (`complete_in_progress`, so no update can change what is being paid
 * for), place the hold, start the order keyed by the session, and give the hold back if the order
 * can't be placed. The caller says how it pays (`PaymentAuthorizer`) and how its orders are named
 * (`CheckoutCaller`); what the answer looks like and how a refusal is framed stay with it.
 */

import { type CheckoutSession, type FlowVersion, isPickup, toMinor } from '@commerceworker/core';
import { startOrderOnce } from '../orders';
import type { CheckoutCaller } from './caller';
import { type PaymentAuthorizer, releaseHold } from './payments';
import { bump, refresh, save } from './session';

/**
 * The session to show, that another write won the race for it, or (only when the caller named the
 * total its buyer saw) that the price now differs: the session is written priced again and nothing
 * is claimed.
 */
export type Completed =
  | { kind: 'session'; session: CheckoutSession }
  | { kind: 'changed'; session: CheckoutSession }
  | { kind: 'raced' };

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
  /** The total the buyer saw: completing is refused (`changed`) when the price now differs. */
  shownTotal?: number,
): Promise<Completed> {
  // Priced again now: the hold must be for what the flow will charge.
  const fresh = await refresh(env, flow, s, caller);
  if (
    shownTotal !== undefined &&
    fresh.quote &&
    toMinor(fresh.quote.total, fresh.currency) !== toMinor(shownTotal, fresh.currency)
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
  const claimed = bump(fresh, { status: 'complete_in_progress', issues: [] });
  if (!(await save(env, claimed, s.version))) return raced;

  let auth: Awaited<ReturnType<PaymentAuthorizer['authorize']>>;
  try {
    auth = await payment.authorize(claimed);
  } catch (err) {
    // The processor failed, not the card: open the session again so the caller can retry.
    await save(env, bump(claimed, { status: 'ready_for_complete' }), claimed.version);
    throw err;
  }
  if (!auth.ok) {
    const next = bump(claimed, retryable(auth.code, auth.content));
    return (await save(env, next, claimed.version)) ? shown(next) : raced;
  }

  const q = claimed.quote!;
  const name = [claimed.buyer.firstName, claimed.buyer.lastName].filter(Boolean).join(' ');
  const appliedCodes = (q.discounts?.applied ?? []).flatMap((a) =>
    a.code === null ? [] : [a.code],
  );
  let orderId: string;
  try {
    const started = await startOrderOnce(env, {
      flowId: flow.id,
      version: flow.version,
      idempotencyKey: `${caller.idempotencyPrefix}:${claimed.id}`,
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
    if (auth.payment?.intentId) await releaseHold(env, auth.payment.intentId);
    const next = bump(claimed, {
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
