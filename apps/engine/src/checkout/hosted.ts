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
  HOSTED_CONFIRMATION_TOKEN,
  HOSTED_ID,
  HOSTED_PAY_ATTEMPTS,
  HOSTED_SECRET,
  type HostedChange,
  type HostedCheckout,
  type HostedCheckoutSettings,
  type HostedPayInput,
  type HostedPayment,
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
  toMinor,
} from '@commerceworker/core';
import { loadFlowVersion } from '../flows';
import { stripeFor } from '../gateway';
import { guestActor } from '../principal';
import { type PaymentIntent, StripeError } from '../stripe';
import { ucpSettings } from '../ucp/config';
import { checkoutSessions, pricingStore, workspaceStore } from '../wire';
import type { CheckoutCaller } from './caller';
import { completeFromOrder, completeSession, placeOrder } from './complete';
import { type Authorized, declined, type PaymentAuthorizer, releaseHold } from './payments';
import { bump, current, newSession, refresh, save } from './session';

/** The hosted checkout's settings: off until an admin turns it on. */
export async function storefrontSettings(env: Env): Promise<StorefrontSettings> {
  return readStorefrontSettings(await workspaceStore(env).setting(STOREFRONT_SETTINGS_KEY));
}

/**
 * Whether payments are only recorded (PAYMENTS_MODE "mock", the default): a hosted checkout then
 * completes without a card, as a test order. Anything else is real money, taken only by card with
 * the buyer's own payment (`payHosted`); an unknown mode is a configuration error `stripeMode`
 * reports where a payment is placed.
 */
const testPayments = (env: Env) => String(env.PAYMENTS_MODE ?? 'mock') === 'mock';

/**
 * What the storefront may know of them. The publishable key is public by design and given only when
 * payments are live (`stripe`) and one is configured: the page offers a card exactly when this
 * engine can take one.
 */
export async function publicSettings(env: Env): Promise<HostedCheckoutSettings> {
  const { enabled, editLines } = (await storefrontSettings(env)).checkout;
  return {
    checkout: {
      enabled,
      editLines,
      testPayments: testPayments(env),
      publishableKey:
        String(env.PAYMENTS_MODE) === 'stripe' && env.STRIPE_PUBLISHABLE_KEY
          ? env.STRIPE_PUBLISHABLE_KEY
          : null,
    },
  };
}

/** Apple Pay's domain verification text for the storefront's host, or null when none is set. */
export const applePayDomainAssociation = (env: Env) => env.APPLE_PAY_DOMAIN_ASSOCIATION || null;

/** The flow a hosted checkout is priced by: its own setting, else the one UCP checks out with. */
async function hostedFlow(env: Env, settings: StorefrontSettings) {
  const id = settings.checkout.checkoutFlowId ?? (await ucpSettings(env)).checkoutFlowId;
  return id ? loadFlowVersion(env, id) : null;
}

/**
 * A hosted buyer as the checkout knows a caller: the web channel, its own idempotency namespace,
 * and `meta.hosted` on the orders it places (what tells them from the channel's other orders).
 */
const callerOf = (ownerId: string): CheckoutCaller => ({
  ownerId,
  channel: 'web',
  idempotencyPrefix: 'hosted',
  meta: { hosted: true },
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
 * mock payment). It is the UCP test handler's twin, used only while payments are only recorded; it
 * never reaches the customer's account, credit or a saved card.
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
 * Places the order for the buyer's session, in test mode only (live payments take a card: `payHosted`). A completed session answers again
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
  if (!testPayments(env)) return refused(s, 'This checkout is paid by card.');
  // Only the checkout the buyer saw: a version or a total they were not shown places no order.
  if (shown?.version !== undefined && shown.version !== s.version) return refused(s, CHANGED, true);
  const total = shown?.total;
  if (total !== undefined && (typeof total !== 'number' || !Number.isFinite(total)))
    return refused(s, CHANGED, true);
  // The flow is loaded and checked now, not when the setting was saved: a later version may no
  // longer authorize a card, or may carry the order on account (`checkoutFlowProblem`).
  const flow = await hostedFlow(env, found.settings);
  if (!flow || checkoutFlowProblem(flow as unknown as FlowGraph))
    return refused(s, 'Checkout is not set up for this business.');
  const done = await completeSession(
    env,
    found.caller,
    flow,
    s,
    holdsNothingOnlyInTestMode(env, TEST_PAYMENT),
    total === undefined ? {} : { shownTotal: total },
  );
  if (done.kind === 'changed') return refused(done.session, CHANGED, true);
  if (done.kind === 'raced')
    return refused((await current(env, found.caller, found.id)) ?? s, CHANGED, true);
  return done.session.status === 'completed'
    ? { ok: true, checkout: hostedView(done.session) }
    : refused(done.session, 'Finish the details below, then place the order.');
}

// ── Card payment ────────────────────────────────────────────────────────────

/** What a buyer is told when their card is refused: the bank's reason is theirs to ask for. */
const CARD_DECLINED = 'Your card was declined. Try another card or payment method.';

/**
 * The buyer's own card, held for the claimed session's quoted total (never anything the page said):
 * a PaymentIntent confirmed with the confirmation token their browser made, manual capture, no
 * redirects, keyed by the session, the token and the amount, so a press retried after a lost answer
 * replays the same hold instead of placing a second. No customer, saved method or `off_session`
 * is part of the call (`paymentIntents.confirmWithToken`), whatever customer prices the session,
 * so this is the buyer's instrument alone. It ends as the hold the order's authorize node adopts
 * (`requires_capture`), the bank's step for the buyer's browser (`requires_action`), or a decline.
 */
async function holdCard(env: Env, s: CheckoutSession, token: string): Promise<Authorized> {
  const stripe = stripeFor(env);
  const amount = toMinor(s.quote?.total ?? 0, s.currency);
  if (amount < 1) return declined('There is nothing to pay by card on this order.');
  const key = intentKey(s.id, token, amount);
  try {
    const pi = await stripe.paymentIntents.confirmWithToken(intentParams(s, token, amount), key);
    if (pi.status === 'requires_capture')
      return { ok: true, payment: { provider: 'stripe', intentId: pi.id } };
    if (pi.status === 'requires_action' && pi.client_secret)
      return {
        ok: false,
        code: 'requires_action',
        content: 'Your bank needs to confirm this payment.',
        action: { intentId: pi.id, clientSecret: pi.client_secret },
      };
    // Anything else (processing, a method that settles later) can't become an order's hold.
    await stripe.paymentIntents.cancel(pi.id, {}, `${key}_cancel`).catch(() => {});
    return declined('That payment could not be held. Try another card or payment method.');
  } catch (err) {
    if (err instanceof StripeError && err.isCardError) {
      // The refused intent is ours and holds nothing; closing it leaves no open intent behind.
      const refused = err.paymentIntent?.id;
      if (refused) await stripe.paymentIntents.cancel(refused, {}, `${key}_cancel`).catch(() => {});
      return declined(CARD_DECLINED);
    }
    throw err;
  }
}

const intentKey = (id: string, token: string, amount: number) => `hosted_${id}_${token}_${amount}`;
const intentParams = (s: CheckoutSession, token: string, amount: number) => ({
  amount,
  currency: s.currency.toLowerCase(),
  confirmationToken: token,
  description: `Checkout ${s.id}`,
  metadata: { checkout_id: s.id },
});

/** A pay request as the page posts it, or null when it is not one. */
function payInput(v: unknown): HostedPayInput | null {
  const p = v as Partial<HostedPayInput> | null;
  if (!p || typeof p !== 'object') return null;
  if (
    typeof p.confirmationToken !== 'string' ||
    !HOSTED_CONFIRMATION_TOKEN.test(p.confirmationToken)
  )
    return null;
  return p as HostedPayInput;
}

/** Why the flow can't take this payment now, or null: loaded fresh, not as it was when the setting was saved. */
async function flowFor(env: Env, settings: StorefrontSettings) {
  const flow = await hostedFlow(env, settings);
  return flow && !checkoutFlowProblem(flow as unknown as FlowGraph) ? flow : null;
}

/**
 * Pays the buyer's session by card, for the version and total they saw. Priced again first and
 * refused (`changed`, no PaymentIntent made) when either differs; the session is claimed, then the
 * card held and the order started adopting that hold (`placeOrder`). A card the bank must
 * authenticate answers `authenticate` and leaves the session claimed with the intent recorded; a
 * decline reopens it with the reason. Each claimed attempt counts against `HOSTED_PAY_ATTEMPTS`.
 * A press retried with the token the session is already being paid with (its answer was lost)
 * resumes that payment: the same intent, never a second.
 */
export async function payHosted(
  env: Env,
  id: unknown,
  secret: unknown,
  signed: SignedActor,
  pay: unknown,
): Promise<HostedPayment | null> {
  const found = await buyerOf(env, id, secret, signed);
  const s = found && (await current(env, found.caller, found.id));
  if (!found || !s) return null;
  if (s.status === 'completed') return { ok: true, checkout: hostedView(s) };
  if (isFinalCheckout(s)) return refused(s, `The checkout is ${s.status}.`);
  if (testPayments(env)) return refused(s, 'This checkout does not take a card.');
  const input = payInput(pay);
  if (!input) return refused(s, 'Your card details could not be read. Try again.');
  const resume =
    s.status === 'complete_in_progress' && s.payment?.token === input.confirmationToken;
  if (s.status === 'complete_in_progress' && !resume)
    return refused(s, 'The checkout is being completed; it cannot change now.');
  if (!resume) {
    if ((s.payment?.attempts ?? 0) >= HOSTED_PAY_ATTEMPTS)
      return refused(s, 'Too many payment attempts. Ask the business for a new link.');
    // Only the checkout the buyer saw: a version or a total they were not shown is created no intent.
    if (input.version !== s.version) return refused(s, CHANGED, true);
    if (typeof input.total !== 'number' || !Number.isFinite(input.total))
      return refused(s, CHANGED, true);
  }
  const flow = await flowFor(env, found.settings);
  if (!flow) return refused(s, 'Checkout is not set up for this business.');

  const done = await completeSession(
    env,
    found.caller,
    flow,
    s,
    holdsNothingOnlyInTestMode(env, {
      refusal: null,
      authorize: (claimed) => holdCard(env, claimed, input.confirmationToken),
    }),
    {
      shownTotal: input.total,
      resume,
      claim: {
        payment: { attempts: (s.payment?.attempts ?? 0) + 1, token: input.confirmationToken },
      },
    },
  );
  if (done.kind === 'changed') return refused(done.session, CHANGED, true);
  if (done.kind === 'raced')
    return refused((await current(env, found.caller, found.id)) ?? s, CHANGED, true);
  if (done.kind === 'action')
    return {
      ok: true,
      checkout: hostedView(done.session),
      authenticate: { clientSecret: done.clientSecret },
    };
  if (done.session.status === 'completed') return { ok: true, checkout: hostedView(done.session) };
  const why = done.session.issues.find((i) => i.path === '$.payment');
  return refused(done.session, why?.content ?? 'Finish the details below, then pay.');
}

/** The session open again for another card, with why, keeping only its attempt count. */
async function reopenSession(env: Env, s: CheckoutSession, content: string) {
  await save(
    env,
    bump(s, {
      status: 'ready_for_complete',
      issues: [
        {
          kind: 'error',
          code: 'payment_failed',
          content,
          path: '$.payment',
          severity: 'recoverable',
        },
      ],
      payment: { attempts: s.payment?.attempts ?? 0 },
    }),
    s.version,
  );
}

/** How a payment the buyer or the sweep looked at ended. */
type Settled = 'placed' | 'waiting' | 'released';

/**
 * Takes a claimed session's payment where it stands: the hold (read from Stripe by the intent it
 * recorded, or by replaying the creation under the same key when the answer was lost) is for this
 * checkout, this amount and open, so the order is placed adopting it; a payment the bank refused or
 * that is for something else is released, and the session reopened with the reason. `final` says no
 * more waiting for the bank (the sweep): an intent still awaiting authentication is released too.
 */
async function settle(
  env: Env,
  caller: CheckoutCaller,
  flow: Awaited<ReturnType<typeof flowFor>>,
  s: CheckoutSession,
  final: boolean,
): Promise<Settled> {
  // An order this session already started (its completion's save was lost) is the answer: the
  // intent may be its own, even captured by now, and is not ours to release or to reopen over.
  if (await completeFromOrder(env, caller, s)) return 'placed';
  const stripe = stripeFor(env);
  const token = s.payment?.token;
  let pi: PaymentIntent | null = null;
  try {
    if (s.payment?.intentId) pi = await stripe.paymentIntents.retrieve(s.payment.intentId);
    else if (token) {
      const amount = toMinor(s.quote?.total ?? 0, s.currency);
      pi = await stripe.paymentIntents.confirmWithToken(
        intentParams(s, token, amount),
        intentKey(s.id, token, amount),
      );
    }
  } catch (err) {
    // A card refused, or a request Stripe will never accept (an intent or a token that is gone, an
    // idempotency window that has passed) has no hold to find; Stripe's own trouble is tried again.
    if (!(err instanceof StripeError && (err.isCardError || !err.isRetryable))) throw err;
    pi = null;
  }
  const reopen = async (content: string): Promise<Settled> => {
    await reopenSession(env, s, content);
    return 'released';
  };
  if (!pi) return reopen(CARD_DECLINED);
  // Another checkout's intent is never ours to release or to place an order on.
  if (pi.metadata?.checkout_id !== s.id) return reopen('We couldn’t confirm that payment.');
  const amount = toMinor(s.quote?.total ?? 0, s.currency);
  if (pi.amount !== amount || pi.currency !== s.currency.toLowerCase()) {
    await releaseHold(env, pi.id);
    return reopen('We couldn’t confirm that payment.');
  }
  if (pi.status === 'requires_capture' && flow) {
    const done = await placeOrder(env, caller, flow, s, { provider: 'stripe', intentId: pi.id });
    return done.kind === 'session' && done.session.status === 'completed' ? 'placed' : 'released';
  }
  if (pi.status === 'requires_action' && !final) return 'waiting';
  // Refused by the bank, never finished, or a flow that can no longer take it: let it go.
  await releaseHold(env, pi.id);
  return reopen(
    pi.status === 'requires_capture'
      ? 'Checkout is not set up for this business.'
      : 'That payment was not completed. Try again.',
  );
}

/**
 * Finishes a card payment the buyer authenticated (`handleNextAction` in their browser): places the
 * order when Stripe says the intent this session recorded is an open authorization for this
 * checkout and its quoted amount; releases it and reopens the session when the bank refused.
 */
export async function confirmHostedPayment(
  env: Env,
  id: unknown,
  secret: unknown,
  signed: SignedActor,
): Promise<HostedChange | null> {
  const found = await buyerOf(env, id, secret, signed);
  const s = found && (await current(env, found.caller, found.id));
  if (!found || !s) return null;
  if (s.status === 'completed') return { ok: true, checkout: hostedView(s) };
  if (testPayments(env) || s.status !== 'complete_in_progress' || !s.payment?.token)
    return refused(s, 'There is no payment to confirm.');
  const flow = await flowFor(env, found.settings);
  const outcome = await settle(env, found.caller, flow, s, false);
  const now = (await current(env, found.caller, found.id)) ?? s;
  if (outcome === 'placed') return { ok: true, checkout: hostedView(now) };
  if (outcome === 'waiting')
    return refused(now, 'Your bank has not confirmed this payment yet. Try again in a moment.');
  return refused(now, now.issues.find((i) => i.path === '$.payment')?.content ?? CHANGED);
}

/** How long a claimed payment may sit before the sweep takes it up: past any bank step a buyer is on. */
export const ORPHAN_HOLD_MS = 15 * 60_000;

/** After this many sweeps that could not settle a payment, it is given up on. */
export const MAX_FAILED_SWEEPS = 5;

/**
 * Counts a sweep that could not settle `s`; at `MAX_FAILED_SWEEPS` it lets go: any hold it recorded
 * is released (as far as Stripe lets it) and the session reopened with a clear reason, so it can't
 * sit claimed forever. Never throws: the next sweep tries again.
 */
async function failedSweep(env: Env, s: CheckoutSession) {
  const sweeps = (s.payment?.sweeps ?? 0) + 1;
  try {
    if (sweeps < MAX_FAILED_SWEEPS) {
      await save(env, bump(s, { payment: { attempts: 0, ...s.payment, sweeps } }), s.version);
      return;
    }
    if (s.payment?.intentId) await releaseHold(env, s.payment.intentId).catch(() => {});
    await reopenSession(env, s, 'We couldn’t finish that payment. Try again.');
    console.warn(JSON.stringify({ type: 'orphaned_hold_given_up', checkout: s.id }));
  } catch (err) {
    console.warn(JSON.stringify({ type: 'orphaned_hold_unsaved', checkout: s.id }), err);
  }
}

/**
 * The sweep's step for card payments that began and never finished (the Worker died after the hold
 * and before the order, or the buyer left the bank's page): each hosted session claimed longer ago
 * than `ORPHAN_HOLD_MS` is taken where it stands (`settle`), so a hold that is open for this
 * checkout becomes its order and anything else is released and the session reopened. Returns what
 * it did; one session failing is logged and left for the next run.
 */
export async function settleOrphanedHolds(env: Env, now = Date.now()) {
  const counts = { placed: 0, released: 0, failed: 0 };
  if (testPayments(env)) return counts;
  const stuck = await checkoutSessions(env).stuckHosted(now - ORPHAN_HOLD_MS, 50);
  if (!stuck.length) return counts;
  const flow = await flowFor(env, await storefrontSettings(env));
  for (const s of stuck) {
    try {
      const outcome = await settle(env, callerOf(s.ownerId), flow, s, true);
      if (outcome === 'placed') counts.placed++;
      else counts.released++;
    } catch (err) {
      counts.failed++;
      console.warn(JSON.stringify({ type: 'orphaned_hold_failed', checkout: s.id }), err);
      await failedSweep(env, s);
    }
  }
  return counts;
}
