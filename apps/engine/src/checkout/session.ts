/**
 * The checkout's sessions and pricing, the same for every caller. Sessions live in D1
 * (`checkout_sessions`) behind the checkout sessions port; every write compares the version it read,
 * so an update racing a completion loses instead of changing a session that is being paid for. A
 * session is priced again on every write by the checkout flow's own pricing nodes (./quote.ts).
 */

import {
  BASE_CURRENCY,
  CHECKOUT_TTL_MS,
  type CheckoutIssue,
  type CheckoutSession,
  type FlowVersion,
  isExpired,
  isPickup,
  missingInfo,
  newId,
  openStatus,
  pickupLineIssues,
  type UcpCheckoutInput,
} from '@commerceworker/core';
import { checkoutSessions } from '../wire';
import type { CheckoutCaller } from './caller';
import { pickupCheck } from './pickup';
import { quoteCheckout } from './quote';

/** A session with nothing in it yet, owned by `ownerId`; the caller patches it and prices it (`refresh`). */
export function newSession(ownerId: string, now = Date.now()): CheckoutSession {
  return {
    id: newId('chk'),
    ownerId,
    status: 'incomplete',
    currency: BASE_CURRENCY,
    lines: [],
    buyer: {},
    fulfillment: 'ship',
    shipTo: null,
    shippingOption: null,
    quote: null,
    issues: [],
    orderId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + CHECKOUT_TTL_MS,
    version: 1,
  };
}

/** The caller's session, or null when it is another owner's or doesn't exist. */
export const load = (env: Env, caller: CheckoutCaller, id: string) =>
  checkoutSessions(env).load(caller.ownerId, id);

/** Writes `next` over the version it was read at; false when someone wrote in between. */
export const save = (env: Env, next: CheckoutSession, readVersion: number) =>
  checkoutSessions(env).save(next, readVersion);

export const bump = (s: CheckoutSession, changes: Partial<CheckoutSession>): CheckoutSession => ({
  ...s,
  ...changes,
  version: s.version + 1,
  updatedAt: Date.now(),
});

/** The session, expired first if its time is up. */
export async function current(env: Env, caller: CheckoutCaller, id: string) {
  const s = await load(env, caller, id);
  if (!s || !isExpired(s, Date.now())) return s;
  const expired = bump(s, {
    status: 'canceled',
    issues: [{ kind: 'info', code: 'expired', content: 'This checkout expired.' }],
  });
  return (await save(env, expired, s.version)) ? expired : load(env, caller, id);
}

/** Prices the session and works out its issues and status (for a session that is open). */
export async function refresh(
  env: Env,
  flow: FlowVersion,
  s: CheckoutSession,
  caller: CheckoutCaller,
  input?: UcpCheckoutInput,
): Promise<CheckoutSession> {
  // A session for a customer is priced as theirs (contract prices, credit), on its caller's channel.
  const { quote, issues } = await quoteCheckout(env, flow, s, {
    channel: caller.channel,
    ...(s.customerId ? { customerId: s.customerId } : {}),
  });
  const priced = { ...s, quote };
  // The stores that could take the order are worked out once, here, and kept on the session for
  // every response; a store the platform chose must be one of them.
  const pickup = quote?.ships ? await pickupCheck(env, flow, priced) : null;
  const pickupIssues: CheckoutIssue[] = [
    ...(pickup?.problem && isPickup(s)
      ? [
          {
            kind: 'error' as const,
            code: 'pickup_unavailable',
            content: pickup.problem,
            path: '$.fulfillment',
            severity: 'recoverable' as const,
          },
        ]
      : []),
    ...(isPickup(s) ? pickupLineIssues(input, priced) : []),
  ];
  const all: CheckoutIssue[] = [
    ...issues,
    ...pickupIssues,
    ...missingInfo(priced),
    ...(caller.protocolIssues?.(priced) ?? []),
  ];
  return {
    ...priced,
    pickupStores: caller.pickupStores === false ? [] : (pickup?.stores ?? []),
    issues: all,
    status: openStatus(all),
  };
}
