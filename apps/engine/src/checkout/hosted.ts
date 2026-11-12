/**
 * The hosted checkout as the engine serves it (`StorefrontApi`): a session an operator makes through
 * the API, a one-time start link the storefront redeems, then the buyer's page reading and changing
 * its session. The engine mints every credential here and stores only hashes. A session is owned
 * by the hash of its start token, then, once the link is redeemed, by the hash of a cookie secret
 * (`hostedOwner`). The storefront carries that secret in a cookie and presents it with each call,
 * with a guest actor it signed for `checkout:<id>`; the engine hashes it to compare, so a stored
 * owner is no credential. Neither alone opens a session, and a session a UCP
 * platform owns (or anyone else) reads as missing. The checkout itself (pricing, completion) is the
 * one UCP uses (./session.ts, ./complete.ts); this names its caller.
 */

import {
  type CheckoutPatch,
  type CheckoutSession,
  checkoutFlowProblem,
  constantTimeEqual,
  type FlowGraph,
  HOSTED_ID,
  HOSTED_SECRET,
  type HostedChange,
  type HostedCheckout,
  type HostedCheckoutSettings,
  hostedCall,
  hostedGuestId,
  hostedHash,
  hostedOwner,
  hostedPatchSchema,
  hostedPatchWithLinesSchema,
  hostedStartOwner,
  hostedStartPath,
  hostedView,
  isFinalCheckout,
  patchCheckout,
  readStorefrontSettings,
  type SignedActor,
  STOREFRONT_SETTINGS_KEY,
  type StorefrontSettings,
  type ToolInput,
} from '@commerceworker/core';
import { loadFlowVersion } from '../flows';
import { guestActor } from '../principal';
import { ucpSettings } from '../ucp/config';
import { checkoutSessions, pricingStore, workspaceStore } from '../wire';
import type { CheckoutCaller } from './caller';
import { completeSession } from './complete';
import type { PaymentAuthorizer } from './payments';
import { bump, current, newSession, refresh, save } from './session';

/** The hosted checkout's settings: off until an admin turns it on. */
export async function storefrontSettings(env: Env): Promise<StorefrontSettings> {
  return readStorefrontSettings(await workspaceStore(env).setting(STOREFRONT_SETTINGS_KEY));
}

/**
 * Whether payments are only recorded (PAYMENTS_MODE "mock", the default): a hosted checkout then
 * completes without a card, as a test order. Anything else is real money, which this page can't
 * take yet, so it never completes (an unknown mode is a configuration error `stripeMode` reports
 * where a payment is placed).
 */
const testPayments = (env: Env) => String(env.PAYMENTS_MODE ?? 'mock') === 'mock';

/** What the storefront may know of them. */
export async function publicSettings(env: Env): Promise<HostedCheckoutSettings> {
  const { enabled, editLines } = (await storefrontSettings(env)).checkout;
  return { checkout: { enabled, editLines, testPayments: testPayments(env) } };
}

/** The flow a hosted checkout is priced by: its own setting, else the one UCP checks out with. */
async function hostedFlow(env: Env, settings: StorefrontSettings) {
  const id = settings.checkout.checkoutFlowId ?? (await ucpSettings(env)).checkoutFlowId;
  return id ? loadFlowVersion(env, id) : null;
}

/** A hosted buyer as the checkout knows a caller: the web channel, its own idempotency namespace. */
const callerOf = (ownerId: string): CheckoutCaller => ({
  ownerId,
  channel: 'web',
  idempotencyPrefix: 'hosted',
});

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/**
 * Makes a hosted session and its start link, priced now. Refused while hosted checkout is off, with
 * no storefront or flow to run it, for a customer that doesn't exist, or when nothing in it can be bought.
 */
export async function createHostedCheckout(
  env: Env,
  i: ToolInput<'create_checkout'>,
): Promise<{ ok: true; id: string; url: string } | { ok: false; error: string }> {
  const settings = await storefrontSettings(env);
  if (!settings.checkout.enabled)
    return { ok: false, error: 'Hosted checkout is not turned on for this workspace.' };
  if (!env.STOREFRONT_ORIGIN)
    return { ok: false, error: 'This deployment has no storefront to host a checkout.' };
  const flow = await hostedFlow(env, settings);
  if (!flow) return { ok: false, error: 'Hosted checkout has no checkout flow to price it.' };
  if (i.customerId && !(await pricingStore(env).customer(i.customerId)))
    return { ok: false, error: `No customer ${i.customerId}.` };

  const token = randomHex(24);
  const owner = hostedStartOwner(await hostedHash(token));
  const patch: CheckoutPatch = {
    lines: i.lines,
    ...(i.buyer ? { buyer: i.buyer } : {}),
    ...(i.shipTo ? { shipTo: i.shipTo } : {}),
  };
  const s = await refresh(
    env,
    flow,
    patchCheckout(
      { ...newSession(owner), ...(i.customerId ? { customerId: i.customerId } : {}) },
      patch,
    ),
    callerOf(owner),
  );
  // Nothing in it can be bought: there is no checkout to make a link for.
  const unavailable = s.issues.filter((x) => x.code === 'item_unavailable');
  if (unavailable.length === s.lines.length)
    return { ok: false, error: unavailable.map((x) => x.content).join(' ') };
  await checkoutSessions(env).create(s);
  return { ok: true, id: s.id, url: `${env.STOREFRONT_ORIGIN}${hostedStartPath(s.id, token)}` };
}

/**
 * Redeems a start link, once: the session passes from the token's hash to the hash of a fresh
 * cookie secret in one write, so a second redemption (or a replay) finds nothing to take. The
 * secret leaves here only in this answer. Null for an unknown, used or expired link, or while off.
 */
export async function redeemHostedStart(env: Env, id: unknown, token: unknown) {
  if (typeof id !== 'string' || !HOSTED_ID.test(id)) return null;
  if (typeof token !== 'string' || !token || token.length > 100) return null;
  if (!(await storefrontSettings(env)).checkout.enabled) return null;
  const secret = randomHex(32);
  const claimed = await checkoutSessions(env).transfer(
    id,
    hostedStartOwner(await hostedHash(token)),
    hostedOwner(await hostedHash(secret)),
    Date.now(),
  );
  return claimed ? { secret, expiresAt: claimed.expiresAt } : null;
}

/**
 * The caller for a buyer's call, or null: hosted checkout must be on, the actor signed under the
 * storefront key for this one session, and the hash of the cookie's secret the session's owner, compared in
 * constant time (a missing session is compared too, so its absence takes no shorter). Everyone
 * else, a UCP platform's session included, is null.
 */
async function buyerOf(
  env: Env,
  id: unknown,
  secret: unknown,
  signed: SignedActor,
): Promise<{ caller: CheckoutCaller; settings: StorefrontSettings; id: string } | null> {
  if (typeof id !== 'string' || !HOSTED_ID.test(id)) return null;
  if (typeof secret !== 'string' || !HOSTED_SECRET.test(secret)) return null;
  const actor = await guestActor(env, signed, hostedCall(id));
  if (!actor || actor.id !== hostedGuestId(id)) return null;
  const settings = await storefrontSettings(env);
  if (!settings.checkout.enabled) return null;
  const owner = await checkoutSessions(env).ownerOf(id);
  const expected = hostedOwner(await hostedHash(secret));
  if (!constantTimeEqual(owner ?? '', expected) || owner === null) return null;
  return { caller: callerOf(expected), settings, id };
}

export async function readHosted(
  env: Env,
  id: unknown,
  secret: unknown,
  signed: SignedActor,
): Promise<HostedCheckout | null> {
  const found = await buyerOf(env, id, secret, signed);
  const s = found && (await current(env, found.caller, found.id));
  return s ? hostedView(s) : null;
}

/** A refusal shown with the session as it is; `changed` when it moved under the request. */
const refused = (s: CheckoutSession, error: string, changed?: true): HostedChange => ({
  ok: false,
  error,
  checkout: hostedView(s),
  ...(changed ? { changed } : {}),
});

const CHANGED = 'This checkout changed. Review it as it is now.';

export async function updateHosted(
  env: Env,
  id: unknown,
  patch: unknown,
  secret: unknown,
  signed: SignedActor,
  version?: unknown,
): Promise<HostedChange | null> {
  const found = await buyerOf(env, id, secret, signed);
  const s = found && (await current(env, found.caller, found.id));
  if (!found || !s) return null;
  if (s.status === 'complete_in_progress')
    return refused(s, 'The checkout is being completed; it cannot change now.');
  if (isFinalCheckout(s)) return refused(s, `The checkout is ${s.status}.`);
  // The page the buyer changed from is older than the session: they have not seen what is there now.
  if (version !== undefined && version !== s.version) return refused(s, CHANGED, true);

  // Strict: a key this page may not set (a price, the owner, the status) is a refusal, not ignored.
  const parsed = (
    found.settings.checkout.editLines ? hostedPatchWithLinesSchema : hostedPatchSchema
  ).safeParse(patch);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return refused(s, `That change is not allowed${first ? `: ${first.message}` : '.'}`);
  }
  const flow = await hostedFlow(env, found.settings);
  if (!flow) return refused(s, 'Checkout is not set up for this business.');
  const next = await refresh(env, flow, bump(patchCheckout(s, parsed.data), {}), found.caller);
  if (!(await save(env, next, s.version)))
    return refused((await current(env, found.caller, found.id)) ?? s, CHANGED, true);
  return { ok: true, checkout: hostedView(next) };
}

/**
 * The test mode's payment: nothing is held and nothing taken (the order's authorize step records a
 * mock payment). It is the UCP test handler's twin, and the only authorizer a hosted checkout has
 * until it takes a card; it never reaches the customer's account, credit or a saved card.
 */
const TEST_PAYMENT: PaymentAuthorizer = { refusal: null, authorize: async () => ({ ok: true }) };

/**
 * An authorizer that places no payment (nothing held, nothing for the order to adopt) is allowed
 * only while payments are only recorded: it throws, after the session is claimed and so reopened,
 * the moment a live deployment would have placed an order with no payment behind it.
 */
export function holdsNothingOnlyInTestMode(
  env: Env,
  payment: PaymentAuthorizer,
): PaymentAuthorizer {
  return {
    ...payment,
    authorize: async (claimed) => {
      const r = await payment.authorize(claimed);
      if (r.ok && !r.payment?.intentId && !testPayments(env))
        throw new Error('A hosted checkout with live payments needs the buyer’s own payment.');
      return r;
    },
  };
}

/**
 * Places the order for the buyer's session, in test mode only. A completed session answers again
 * as it is, so a retried press places no second order (the order is keyed by the session besides).
 * A session that isn't ready is shown with what is missing and nothing is claimed.
 */
export async function completeHosted(
  env: Env,
  id: unknown,
  secret: unknown,
  signed: SignedActor,
  /** What the buyer's page showed: the session's version and its total. */
  shown?: { version?: unknown; total?: unknown },
): Promise<HostedChange | null> {
  const found = await buyerOf(env, id, secret, signed);
  const s = found && (await current(env, found.caller, found.id));
  if (!found || !s) return null;
  if (s.status === 'completed') return { ok: true, checkout: hostedView(s) };
  if (s.status === 'complete_in_progress')
    return refused(s, 'The checkout is being completed; it cannot change now.');
  if (isFinalCheckout(s)) return refused(s, `The checkout is ${s.status}.`);
  if (!testPayments(env)) return refused(s, 'Card payment is not available on this page yet.');
  // Only the checkout the buyer saw: a version or a total they were not shown places no order.
  if (shown?.version !== undefined && shown.version !== s.version) return refused(s, CHANGED, true);
  const total = shown?.total;
  if (total !== undefined && (typeof total !== 'number' || !Number.isFinite(total)))
    return refused(s, CHANGED, true);
  // The flow is loaded and checked now, not when the setting was saved: a later version may no
  // longer authorize a card. (A live authorizer, when a card is taken here, must also: return the
  // buyer's own `payment.intentId` for the order to adopt, and be refused without one
  // (`holdsNothingOnlyInTestMode`); refuse a flow that carries the order on account
  // (`commerce.invoice` with onAccount, `commerce.charge`); and never use the customer's credit or
  // saved cards, whatever `customerId` prices.)
  const flow = await hostedFlow(env, found.settings);
  if (!flow || checkoutFlowProblem(flow as unknown as FlowGraph))
    return refused(s, 'Checkout is not set up for this business.');
  const done = await completeSession(
    env,
    found.caller,
    flow,
    s,
    holdsNothingOnlyInTestMode(env, TEST_PAYMENT),
    total,
  );
  if (done.kind === 'changed') return refused(done.session, CHANGED, true);
  if (done.kind === 'raced')
    return refused((await current(env, found.caller, found.id)) ?? s, CHANGED, true);
  return done.session.status === 'completed'
    ? { ok: true, checkout: hostedView(done.session) }
    : refused(done.session, 'Finish the details below, then place the order.');
}
