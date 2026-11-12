/**
 * Paying a hosted checkout by card, against the Stripe fake: the buyer's browser makes a
 * confirmation token, the engine prices the session again, holds the quoted total on the buyer's own
 * card and starts the order adopting that hold. The refusals matter as much: a page that was not
 * the session's, a flow that carries the order on account, a customer's saved card (never used), a
 * card that is declined, one the bank must authenticate, a press whose answer was lost, and holds a
 * payment left behind (the sweep).
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  HOSTED_PAY_ATTEMPTS,
  type HostedPayment,
  hostedCall,
  hostedGuestId,
  hostedHash,
  type Order,
  type OrderState,
  operationCall,
  type RpcActor,
  STOREFRONT_SETTINGS_KEY,
  storefrontOrderFlow,
  toMinor,
} from '@commerceworker/core';
import {
  createDb,
  customers,
  messages,
  orders,
  payments,
  workspaceSettings,
} from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EngineApi } from '../../src/api';
import { placeOrder } from '../../src/checkout/complete';
import {
  holdsNothingOnlyInTestMode,
  MAX_FAILED_SWEEPS,
  settleOrphanedHolds,
} from '../../src/checkout/hosted';
import { ensureTemplates, loadFlowVersion } from '../../src/flows';
import { fromOutside, startOrderOnce } from '../../src/orders';
import { authorizePayment } from '../../src/payments';
import { checkoutSessions, flowStore } from '../../src/wire';
import { signedActor, signedGuest, storefrontApi } from '../principal';
import { installStripeFake, type StripeFake } from '../stripe-fake';
import { enableUcp, until } from '../ucp-helpers';

const sf = storefrontApi();
const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const operator: RpcActor = {
  kind: 'staff',
  id: 'usr_pay_op',
  name: 'op@example.com',
  role: 'operator',
};

let stripe: StripeFake;
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

async function setting(flowId?: string) {
  const value = JSON.stringify({
    checkout: { enabled: true, ...(flowId ? { checkoutFlowId: flowId } : {}) },
  });
  await db()
    .insert(workspaceSettings)
    .values({ key: STOREFRONT_SETTINGS_KEY, value, updatedAt: Date.now(), updatedBy: 'test' })
    .onConflictDoUpdate({ target: workspaceSettings.key, set: { value } });
}

beforeAll(async () => {
  await ensureTemplates(env);
  await enableUcp();
});
beforeEach(async () => {
  stripe = installStripeFake();
  await setting();
  introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
});
afterEach(async () => {
  stripe.restore();
  await introspector?.dispose();
  introspector = undefined;
});

const ship = {
  name: 'Ada Lovelace',
  line1: '500 Congress Ave',
  city: 'Austin',
  region: 'TX',
  postalCode: '78701',
  country: 'US',
};

/** A session redeemed and filled in, ready to pay: what the buyer's cookie and calls hold. */
async function ready(extra: Record<string, unknown> = {}) {
  const input = { lines: [{ sku: 'MON-27', qty: 1 }], ...extra };
  const r = await api().runOperation(
    'create_checkout',
    input,
    await signedActor(operator, await operationCall('create_checkout', input)),
  );
  if (!r.ok) throw new Error(JSON.stringify(r));
  const { id, url } = r.value as { id: string; url: string };
  const start = (await sf.redeemCheckoutStart(id, url.split('/').pop()!))!;
  const actor = await signedGuest(
    { kind: 'guest', id: hostedGuestId(id), name: 'Buyer' },
    hostedCall(id),
  );
  const b = { id, secret: start.secret, actor, hash: await hostedHash(start.secret) };
  const set = await sf.updateCheckout(
    id,
    { buyer: { email: 'ada@example.com', firstName: 'Ada' }, shipTo: ship },
    b.secret,
    b.actor,
  );
  if (!set?.ok) throw new Error(JSON.stringify(set));
  return b;
}
type Buyer = Awaited<ReturnType<typeof ready>>;

const view = async (b: Buyer) => (await sf.checkout(b.id, b.secret, b.actor))!;
/** What the page would post: the version and total it shows, and the token. */
const pay = async (
  b: Buyer,
  confirmationToken: string,
  over: { version?: number; total?: number } = {},
) => {
  const c = await view(b);
  return sf.payCheckout(b.id, b.secret, b.actor, {
    version: over.version ?? c.version,
    total: over.total ?? c.quote!.total,
    confirmationToken,
  });
};
const placed = (r: HostedPayment | null) => {
  if (!r?.ok) throw new Error(`not placed: ${JSON.stringify(r)}`);
  return r.checkout;
};
const orderRows = (id: string) =>
  db()
    .select()
    .from(orders)
    .where(eq(orders.idempotencyKey, `hosted:${id}`))
    .all();
const creates = () => stripe.callsTo('POST', '/v1/payment_intents');
const authorization = (orderId: string) =>
  until(async () => {
    const rows = await db().select().from(payments).where(eq(payments.orderId, orderId)).all();
    return rows.find((r) => r.kind === 'authorization:card');
  }, 'the order’s authorization');

describe('paying a hosted checkout by card', () => {
  it('holds the quoted total on the buyer’s card, and the order adopts that hold', async () => {
    const b = await ready();
    const seen = await view(b);
    const done = placed(await pay(b, 'ctoken_happy01'));
    expect(done).toMatchObject({ status: 'completed', orderId: expect.stringMatching(/^ord_/) });

    // The amount is the server's quote, in minor units; the call is a confirmation-token intent.
    const amount = toMinor(seen.quote!.total, seen.currency);
    expect(creates()).toHaveLength(1);
    const [call] = creates();
    expect(call!.params).toMatchObject({
      amount: String(amount),
      currency: 'usd',
      capture_method: 'manual',
      confirm: 'true',
      confirmation_token: 'ctoken_happy01',
      use_stripe_sdk: 'true',
      automatic_payment_methods: { enabled: 'true', allow_redirects: 'never' },
      metadata: { checkout_id: b.id },
    });
    expect(call!.idempotencyKey).toBe(`hosted_${b.id}_ctoken_happy01_${amount}`);
    // Nothing that could reach an account: no customer, no saved method, nothing off session.
    for (const k of ['customer', 'payment_method', 'off_session', 'setup_future_usage'])
      expect(call!.params).not.toHaveProperty(k);

    const [order, ...more] = await orderRows(b.id);
    expect(more).toEqual([]);
    expect(order).toMatchObject({
      id: done.orderId,
      channel: 'web',
      startedBy: `hosted:${b.hash}`,
    });
    const intentId = [...stripe.intents.keys()][0]!;
    // Marked as a hosted checkout's order (what the confirmation email and the receipt go by), and
    // carrying the buyer's own hold for its authorize step to adopt.
    const state = await until(async () => {
      const s = (await env.ORDER_AGENT.getByName(done.orderId!).snapshot()) as OrderState;
      return s.order ? s : false;
    }, 'the order');
    expect(state.order).toMatchObject({
      meta: { hosted: true },
      payment: { provider: 'stripe', intentId },
    });
    expect(await authorization(done.orderId!)).toMatchObject({
      provider: 'stripe',
      externalId: intentId,
    });
    expect(creates()).toHaveLength(1);
    // The paid order is confirmed to its buyer once, after the authorize step adopted the hold
    // (recorded unsent here: the test deployment has no Email Sending binding).
    const confirmation = await until(async () => {
      const rows = await db().select().from(messages).where(eq(messages.orderId, done.orderId!));
      const mine = rows.filter((m) => m.id.endsWith('_confirmation'));
      return mine.length ? mine : false;
    }, 'the order’s confirmation');
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0]).toMatchObject({ recipient: 'ada@example.com' });
  });

  it('answers a second press as it is, with no second intent or order', async () => {
    const b = await ready();
    const first = placed(await pay(b, 'ctoken_twice01'));
    const again = await sf.payCheckout(b.id, b.secret, b.actor, {
      version: first.version,
      total: first.quote!.total,
      confirmationToken: 'ctoken_twice02',
    });
    expect(placed(again).orderId).toBe(first.orderId);
    expect(creates()).toHaveLength(1);
    expect(await orderRows(b.id)).toHaveLength(1);
  });

  it('is the buyer’s alone: another cookie and a token that is not one are refused', async () => {
    const b = await ready();
    expect(
      await sf.payCheckout(b.id, 'f'.repeat(64), b.actor, {
        version: 1,
        total: 1,
        confirmationToken: 'ctoken_other01',
      }),
    ).toBeNull();
    // A guest actor signed for another checkout opens nothing.
    const other = await signedGuest(
      { kind: 'guest', id: hostedGuestId('chk_other'), name: 'Buyer' },
      hostedCall('chk_other'),
    );
    expect(
      await sf.payCheckout(b.id, b.secret, other, {
        version: 1,
        total: 1,
        confirmationToken: 'ctoken_other02',
      }),
    ).toBeNull();
    expect(creates()).toHaveLength(0);
    const c = await view(b);
    const bad = await sf.payCheckout(b.id, b.secret, b.actor, {
      version: c.version,
      total: c.quote!.total,
      confirmationToken: 'pm_card_visa',
    });
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/could not be read/) });
    expect(creates()).toHaveLength(0);
  });
});

describe('what the buyer saw', () => {
  it('refuses a version or a total they were not shown, and makes no PaymentIntent', async () => {
    const b = await ready();
    const seen = await view(b);
    // The session moves (a promo code bumps its version) between the page and the press.
    await sf.updateCheckout(b.id, { promoCodes: ['NOPE'] }, b.secret, b.actor);
    const stale = await pay(b, 'ctoken_stale001', { version: seen.version });
    expect(stale).toMatchObject({ ok: false, changed: true });
    const wrongTotal = await pay(b, 'ctoken_stale002', { total: (await view(b)).quote!.total + 1 });
    expect(wrongTotal).toMatchObject({ ok: false, changed: true });
    const notANumber = await pay(b, 'ctoken_stale003', { total: Number.NaN });
    expect(notANumber).toMatchObject({ ok: false, changed: true });
    expect(creates()).toHaveLength(0);
    expect(await orderRows(b.id)).toEqual([]);
    expect((await view(b)).status).toBe('ready_for_complete');
  });

  it('holds the server’s quote, in minor units', async () => {
    const b = await ready();
    const seen = await view(b);
    placed(await pay(b, 'ctoken_amount01'));
    expect(creates()[0]!.params.amount).toBe(String(toMinor(seen.quote!.total, seen.currency)));
  });
});

describe('a card that needs the bank', () => {
  it('answers authenticate, stays claimed, and places the order once the buyer confirms', async () => {
    const b = await ready();
    const r = await pay(b, 'ctoken_authenticate1');
    expect(r).toMatchObject({
      ok: true,
      authenticate: { clientSecret: expect.stringMatching(/_secret_/) },
    });
    // Claimed: nothing can change, nothing is placed, and the buyer's view shows no intent or token.
    const claimed = await view(b);
    expect(claimed.status).toBe('complete_in_progress');
    expect(JSON.stringify(claimed)).not.toMatch(/pi_fake|ctoken_/);
    expect(await orderRows(b.id)).toEqual([]);
    expect(await sf.updateCheckout(b.id, { promoCodes: [] }, b.secret, b.actor)).toMatchObject({
      ok: false,
    });
    // Not yet confirmed by the bank.
    expect(await sf.confirmCheckoutPayment(b.id, b.secret, b.actor)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not confirmed/),
    });
    // The same press again resumes the same intent.
    const again = await pay(b, 'ctoken_authenticate1', { version: claimed.version });
    expect(again).toMatchObject({ ok: true, authenticate: expect.anything() });
    expect(stripe.intents.size).toBe(1);

    const intentId = [...stripe.intents.keys()][0]!;
    stripe.authenticate(intentId, 'succeed');
    const done = await sf.confirmCheckoutPayment(b.id, b.secret, b.actor);
    expect(done).toMatchObject({ ok: true, checkout: { status: 'completed' } });
    expect(await orderRows(b.id)).toHaveLength(1);
    const orderId = (done as { checkout: { orderId: string } }).checkout.orderId;
    expect(await authorization(orderId)).toMatchObject({
      externalId: intentId,
      provider: 'stripe',
    });
    // Confirming again is the same answer.
    expect(await sf.confirmCheckoutPayment(b.id, b.secret, b.actor)).toMatchObject({ ok: true });
    expect(await orderRows(b.id)).toHaveLength(1);
  });

  it('releases the hold and reopens the session when the bank refuses', async () => {
    const b = await ready();
    await pay(b, 'ctoken_authenticate2');
    const intentId = [...stripe.intents.keys()][0]!;
    stripe.authenticate(intentId, 'fail');
    const r = await sf.confirmCheckoutPayment(b.id, b.secret, b.actor);
    expect(r).toMatchObject({ ok: false, checkout: { status: 'ready_for_complete' } });
    expect(stripe.intents.get(intentId)!.status).toBe('canceled');
    expect(await orderRows(b.id)).toEqual([]);
    // Another card is a new attempt.
    placed(await pay(b, 'ctoken_second0001'));
  });

  it('confirms only for a session that is waiting on a payment', async () => {
    const b = await ready();
    expect(await sf.confirmCheckoutPayment(b.id, b.secret, b.actor)).toMatchObject({
      ok: false,
      error: 'There is no payment to confirm.',
    });
    expect(await sf.confirmCheckoutPayment(b.id, 'f'.repeat(64), b.actor)).toBeNull();
    expect(stripe.calls).toHaveLength(0);
  });
});

describe('a card that is declined', () => {
  it('reopens the session with the reason, leaves no open intent and places no order', async () => {
    const b = await ready();
    const r = await pay(b, 'ctoken_declined001');
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/declined/),
      checkout: { status: 'ready_for_complete' },
    });
    expect(await orderRows(b.id)).toEqual([]);
    expect([...stripe.intents.values()].every((pi) => pi.status === 'canceled')).toBe(true);
    // The buyer may try another card.
    placed(await pay(b, 'ctoken_goodcard001'));
  });

  it('stops after HOSTED_PAY_ATTEMPTS attempts: a stolen link is no card-testing oracle', async () => {
    const b = await ready();
    for (let i = 0; i < HOSTED_PAY_ATTEMPTS; i++)
      expect(await pay(b, `ctoken_declined${i}00`)).toMatchObject({ ok: false });
    expect(creates()).toHaveLength(HOSTED_PAY_ATTEMPTS);
    const capped = await pay(b, 'ctoken_goodcard002');
    expect(capped).toMatchObject({ ok: false, error: expect.stringMatching(/Too many/) });
    expect(creates()).toHaveLength(HOSTED_PAY_ATTEMPTS);
    expect(await orderRows(b.id)).toEqual([]);
  });
});

describe('a press whose answer was lost', () => {
  it('replays the same PaymentIntent, never a second', async () => {
    const b = await ready();
    stripe.loseNextResponse(/\/v1\/payment_intents$/);
    await expect(pay(b, 'ctoken_lost0001')).rejects.toThrow();
    // The engine reopened the session; the buyer presses again with the same token.
    expect((await view(b)).status).toBe('ready_for_complete');
    const done = placed(await pay(b, 'ctoken_lost0001'));
    expect(done.status).toBe('completed');
    expect(creates()).toHaveLength(2);
    expect(creates()[0]!.idempotencyKey).toBe(creates()[1]!.idempotencyKey);
    expect(stripe.intents.size).toBe(1);
    expect(await orderRows(b.id)).toHaveLength(1);
  });

  it('opens the session again when Stripe fails before it does anything', async () => {
    const b = await ready();
    stripe.failNext(/\/v1\/payment_intents$/);
    await expect(pay(b, 'ctoken_fail00001')).rejects.toThrow();
    expect((await view(b)).status).toBe('ready_for_complete');
    expect(stripe.intents.size).toBe(0);
    placed(await pay(b, 'ctoken_fail00001'));
    expect(stripe.intents.size).toBe(1);
  });
});

describe('only the buyer’s own instrument', () => {
  it('never uses a customer’s saved card or Stripe customer, off session or otherwise', async () => {
    await db()
      .update(customers)
      .set({ stripeCustomerId: 'cus_saved_for_hosted', stripePaymentMethodId: 'pm_card_saved' })
      .where(eq(customers.id, 'cus_northwind'));
    try {
      const b = await ready({ customerId: 'cus_northwind' });
      const done = placed(await pay(b, 'ctoken_saved0001'));
      const [call] = creates();
      for (const k of ['customer', 'payment_method', 'off_session', 'setup_future_usage'])
        expect(call!.params).not.toHaveProperty(k);
      // The order's own authorization adopted the buyer's hold; every Stripe call the checkout and
      // its order made, none names the saved card or customer.
      await authorization(done.orderId!);
      expect(JSON.stringify(stripe.calls)).not.toMatch(
        /pm_card_saved|cus_saved_for_hosted|off_session/,
      );
      const [intent] = stripe.intents.values();
      expect(intent).toMatchObject({
        customer: null,
        off_session: false,
        payment_method: 'pm_from_ctoken_saved0001',
      });
    } finally {
      await db()
        .update(customers)
        .set({ stripeCustomerId: null, stripePaymentMethodId: null })
        .where(eq(customers.id, 'cus_northwind'));
    }
  });

  it('refuses a flow that carries the order on account, with no intent made', async () => {
    const flow = storefrontOrderFlow();
    const onAccount = {
      ...flow,
      id: 'tpl-hosted-on-account',
      nodes: [
        ...flow.nodes,
        {
          id: 'inv',
          type: 'commerce.invoice',
          label: 'Invoice',
          config: {},
          position: { x: 0, y: 0 },
        },
      ],
    } as never;
    await flowStore(env).publish(onAccount);
    await setting('tpl-hosted-on-account');
    const b = await ready();
    const r = await pay(b, 'ctoken_account001');
    expect(r).toMatchObject({ ok: false, error: 'Checkout is not set up for this business.' });
    expect(creates()).toHaveLength(0);
    expect(await orderRows(b.id)).toEqual([]);
  });

  it('re-checks the flow at completion, not when the setting was saved', async () => {
    const flow = { ...storefrontOrderFlow(), id: 'tpl-hosted-pay-recheck' } as never;
    await flowStore(env).publish(flow);
    await setting('tpl-hosted-pay-recheck');
    const b = await ready();
    await flowStore(env).publish({ ...(flow as object), nodes: [], edges: [] } as never);
    expect(await pay(b, 'ctoken_recheck001')).toMatchObject({ ok: false });
    expect(creates()).toHaveLength(0);
  });

  it('refuses a live authorizer that holds nothing for the order to adopt', async () => {
    const guarded = holdsNothingOnlyInTestMode(env, {
      refusal: null,
      authorize: async () => ({ ok: true }),
    });
    await expect(guarded.authorize({} as never)).rejects.toThrow(/needs the buyer’s own payment/);
  });

  it('takes no card in test mode', async () => {
    const b = await ready();
    const mode = (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE;
    try {
      (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE = 'mock';
      expect(await pay(b, 'ctoken_testmode01')).toMatchObject({ ok: false });
    } finally {
      (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE = mode;
    }
    expect(creates()).toHaveLength(0);
  });
});

describe('the settings the page is drawn with', () => {
  it('gives the publishable key only while payments are live', async () => {
    expect(await sf.storefrontSettings()).toMatchObject({
      checkout: { testPayments: false, publishableKey: 'pk_test_fake' },
    });
    const mode = (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE;
    try {
      (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE = 'mock';
      expect(await sf.storefrontSettings()).toMatchObject({
        checkout: { testPayments: true, publishableKey: null },
      });
    } finally {
      (env as { PAYMENTS_MODE?: string }).PAYMENTS_MODE = mode;
    }
  });

  it('serves the Apple Pay domain file only when one is set', async () => {
    expect(await sf.applePayDomainAssociation()).toBeNull();
    (env as { APPLE_PAY_DOMAIN_ASSOCIATION?: string }).APPLE_PAY_DOMAIN_ASSOCIATION = '7B227073';
    try {
      expect(await sf.applePayDomainAssociation()).toBe('7B227073');
    } finally {
      delete (env as { APPLE_PAY_DOMAIN_ASSOCIATION?: string }).APPLE_PAY_DOMAIN_ASSOCIATION;
    }
  });
});

describe('payments that began and never finished', () => {
  /** Writes the session as last touched at `to`, as a Worker that died would have left it. */
  const rewind = async (b: Buyer, to: number) => {
    const s = (await checkoutSessions(env).load(`hosted:${b.hash}`, b.id))!;
    await checkoutSessions(env).save({ ...s, version: s.version + 1, updatedAt: to }, s.version);
  };
  const mine = (b: Buyer) =>
    stripe
      .callsTo('POST', /\/v1\/payment_intents/)
      .filter(
        (c) =>
          c.params.metadata && (c.params.metadata as { checkout_id?: string }).checkout_id === b.id,
      );

  it('does nothing for a session claimed a moment ago', async () => {
    const b = await ready();
    await pay(b, 'ctoken_authenticate3');
    await settleOrphanedHolds(env, Date.now());
    expect((await view(b)).status).toBe('complete_in_progress');
    expect(mine(b)).toHaveLength(1);
  });

  it('releases a hold awaiting the bank that the buyer left, and reopens the session', async () => {
    const b = await ready();
    await pay(b, 'ctoken_authenticate4');
    const intentId = [...stripe.intents.keys()][0]!;
    await rewind(b, Date.now() - 3_600_000);
    const r = await settleOrphanedHolds(env, Date.now());
    expect(r.released).toBeGreaterThanOrEqual(1);
    expect(stripe.intents.get(intentId)!.status).toBe('canceled');
    expect(await view(b)).toMatchObject({ status: 'ready_for_complete' });
    expect(await orderRows(b.id)).toEqual([]);
  });

  it('finishes the order when the hold is open for this checkout', async () => {
    const b = await ready();
    await pay(b, 'ctoken_authenticate5');
    const intentId = [...stripe.intents.keys()][0]!;
    // The buyer authenticated, but the call that places the order never came.
    stripe.authenticate(intentId, 'succeed');
    await rewind(b, Date.now() - 3_600_000);
    const r = await settleOrphanedHolds(env, Date.now());
    expect(r.placed).toBeGreaterThanOrEqual(1);
    expect(await view(b)).toMatchObject({ status: 'completed' });
    expect(await orderRows(b.id)).toHaveLength(1);
    expect(stripe.intents.get(intentId)!.status).toBe('requires_capture');
  });

  it('finds a hold whose creation answer was lost, by replaying it under the same key', async () => {
    const b = await ready();
    const c = await view(b);
    const s = (await checkoutSessions(env).load(`hosted:${b.hash}`, b.id))!;
    // Claimed with a token and no intent recorded: the answer never arrived.
    await checkoutSessions(env).save(
      {
        ...s,
        status: 'complete_in_progress',
        version: s.version + 1,
        updatedAt: Date.now() - 3_600_000,
        payment: { attempts: 1, token: 'ctoken_replay0001' },
      },
      c.version,
    );
    // Stripe did make the hold (the first call's response was what got lost).
    const amount = toMinor(c.quote!.total, c.currency);
    const made = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: { 'Idempotency-Key': `hosted_${b.id}_ctoken_replay0001_${amount}` },
      body: new URLSearchParams({
        amount: String(amount),
        currency: 'usd',
        capture_method: 'manual',
        confirm: 'true',
        confirmation_token: 'ctoken_replay0001',
        use_stripe_sdk: 'true',
        'automatic_payment_methods[enabled]': 'true',
        'automatic_payment_methods[allow_redirects]': 'never',
        description: `Checkout ${b.id}`,
        'metadata[checkout_id]': b.id,
      }).toString(),
    });
    expect(made.ok).toBe(true);
    const r = await settleOrphanedHolds(env, Date.now());
    expect(r.placed).toBeGreaterThanOrEqual(1);
    expect(stripe.intents.size).toBe(1);
    expect(await view(b)).toMatchObject({ status: 'completed' });
  });
});

const rewindSession = async (b: Buyer, to: number, over: Record<string, unknown> = {}) => {
  const s = (await checkoutSessions(env).load(`hosted:${b.hash}`, b.id))!;
  await checkoutSessions(env).save(
    { ...s, ...over, version: s.version + 1, updatedAt: to } as never,
    s.version,
  );
};
const longAgo = () => Date.now() - 3_600_000;
const cancels = () => stripe.callsTo('POST', /\/v1\/payment_intents\/[^/]+\/cancel$/);

describe('a hold an order that ended unfulfilled leaves behind', () => {
  /** A hosted order started directly, adopting `intentId`, as a completed checkout would. */
  async function startHosted(n: string, intentId: string, qty = 1) {
    const flow = (await loadFlowVersion(env, 'tpl-storefront-order'))!;
    const started = await startOrderOnce(env, {
      flowId: flow.id,
      version: flow.version,
      idempotencyKey: `hosted:chk_manual_${n}`,
      input: {
        model: flow.model,
        channel: 'web',
        externalId: `chk_manual_${n}`,
        currency: 'USD',
        lines: [{ sku: 'MON-27', name: 'Monitor', qty }],
        contact: { email: 'ada@example.com' },
        fulfillment: { method: 'ship' },
        payment: { provider: 'stripe', intentId },
        meta: { hosted: true, shipTo: ship },
      },
    });
    if ('mismatch' in started) throw new Error('mismatch');
    return started.orderId;
  }
  const ended = (orderId: string) =>
    until(async () => {
      const st = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
      return ['declined', 'cancelled', 'failed', 'rolled_back'].includes(st.status) ? st : false;
    }, 'the order to end');
  const canceled = (id: string) =>
    until(async () => stripe.intents.get(id)?.status === 'canceled', 'the hold to be released');

  it('is released when the store’s policy declines the order before it authorizes', async () => {
    const pi = stripe.authorizedIntent(5000, 'usd', { checkout_id: 'chk_manual_a' });
    const orderId = await startHosted('a', pi.id, 11);
    expect((await ended(orderId)).status).toBe('declined');
    await canceled(pi.id);
  });

  it('is released when the authorize step refuses it for another amount', async () => {
    const pi = stripe.authorizedIntent(100, 'usd', { checkout_id: 'chk_manual_b' });
    const orderId = await startHosted('b', pi.id);
    await ended(orderId);
    await canceled(pi.id);
  });

  it('is released once, however often the order changes after it ended', async () => {
    const pi = stripe.authorizedIntent(100, 'usd', { checkout_id: 'chk_manual_c' });
    const orderId = await startHosted('c', pi.id);
    await ended(orderId);
    await canceled(pi.id);
    // Another change to the ended order (a second terminal transition) cancels nothing again.
    await env.ORDER_AGENT.getByName(orderId)
      .cancel('again')
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 3_500));
    expect(cancels().filter((c) => c.path.includes(pi.id))).toHaveLength(1);
  });

  it('is left alone for an order that was paid and carried on', async () => {
    const b = await ready();
    const done = placed(await pay(b, 'ctoken_kept00001'));
    await authorization(done.orderId!);
    await new Promise((r) => setTimeout(r, 3_000));
    expect(cancels()).toHaveLength(0);
    expect([...stripe.intents.values()].every((pi) => pi.status !== 'canceled')).toBe(true);
  });

  it('is released for no order that is not a checkout’s: an outside caller cannot claim the mark or the key', async () => {
    const base = {
      flowId: 'tpl-storefront-order',
      input: { model: 'b2c', channel: 'api', currency: 'USD', lines: [], meta: { hosted: true } },
    };
    expect(
      (fromOutside({ ...base, input: base.input } as never) as { input: { meta: object } }).input
        .meta,
    ).toEqual({});
    expect(() => fromOutside({ ...base, idempotencyKey: 'hosted:chk_x' } as never)).toThrow(
      /reserved/,
    );
    expect(() => fromOutside({ ...base, idempotencyKey: 'mine:1' } as never)).not.toThrow();
  });
});

describe('an order that already exists for the checkout', () => {
  it('is the checkout’s completion, and its hold is not released, when the flow was published since', async () => {
    const b = await ready();
    placed(await pay(b, 'ctoken_authenticate9'));
    const intentId = [...stripe.intents.keys()][0]!;
    stripe.authenticate(intentId, 'succeed');
    const done = (await sf.confirmCheckoutPayment(b.id, b.secret, b.actor)) as {
      checkout: { orderId: string };
    };
    const orderId = done.checkout.orderId;
    await authorization(orderId);
    // A new flow version, then the session as a lost save would leave it: claimed, no order recorded.
    await flowStore(env).publish({ ...storefrontOrderFlow(), id: 'tpl-storefront-order' } as never);
    await rewindSession(b, longAgo(), { status: 'complete_in_progress', orderId: null });
    const r = await settleOrphanedHolds(env, Date.now());
    expect(r.placed).toBeGreaterThanOrEqual(1);
    expect(await view(b)).toMatchObject({ status: 'completed', orderId });
    expect(stripe.intents.get(intentId)!.status).not.toBe('canceled');
    expect(await orderRows(b.id)).toHaveLength(1);
  });

  it('is found by placeOrder itself on a replay under a new flow version, releasing nothing', async () => {
    const b = await ready();
    placed(await pay(b, 'ctoken_authenticate8'));
    const intentId = [...stripe.intents.keys()][0]!;
    stripe.authenticate(intentId, 'succeed');
    const done = (await sf.confirmCheckoutPayment(b.id, b.secret, b.actor)) as {
      checkout: { orderId: string };
    };
    await flowStore(env).publish({ ...storefrontOrderFlow(), id: 'tpl-storefront-order' } as never);
    const flow = (await loadFlowVersion(env, 'tpl-storefront-order'))!;
    const s = (await checkoutSessions(env).load(`hosted:${b.hash}`, b.id))!;
    const again = await placeOrder(
      env,
      { ownerId: s.ownerId, channel: 'web', idempotencyPrefix: 'hosted', meta: { hosted: true } },
      flow,
      { ...s, status: 'complete_in_progress' },
      { provider: 'stripe', intentId },
    );
    expect(again.kind === 'session' || again.kind === 'raced').toBe(true);
    expect(stripe.intents.get(intentId)!.status).not.toBe('canceled');
    expect(await orderRows(b.id)).toHaveLength(1);
    expect(done.checkout.orderId).toMatch(/^ord_/);
  });
});

describe('a hosted order’s only payment is the buyer’s own', () => {
  const hostedOrder = (id: string, o: Partial<Order> = {}): Order =>
    ({
      model: 'b2c',
      channel: 'web',
      currency: 'USD',
      lines: [],
      meta: { hosted: true },
      id,
      externalId: 'chk_a',
      customerId: 'cus_northwind',
      createdAt: Date.now(),
      subtotal: 40,
      shipping: 0,
      tax: 0,
      total: 40,
      ...o,
    }) as Order;

  it('is declined for any other source: a saved card, a method on the order, a recorded payment', async () => {
    await db()
      .update(customers)
      .set({ stripeCustomerId: 'cus_saved_h', stripePaymentMethodId: 'pm_card_saved' })
      .where(eq(customers.id, 'cus_northwind'));
    try {
      for (const [id, payment] of [
        ['ord_h_saved', undefined],
        ['ord_h_method', { provider: 'stripe', paymentMethodId: 'pm_card_visa' }],
        ['ord_h_external', { provider: 'external', reference: '1' }],
      ] as const) {
        const r = await authorizePayment(
          env,
          hostedOrder(id, payment ? { payment: payment as never } : {}),
          'authorize#1',
          'card',
        );
        expect(r.status, id).toBe('declined');
      }
      expect(creates()).toHaveLength(0);
      expect(JSON.stringify(stripe.calls)).not.toMatch(/pm_card_saved|pm_card_visa/);
    } finally {
      await db()
        .update(customers)
        .set({ stripeCustomerId: null, stripePaymentMethodId: null })
        .where(eq(customers.id, 'cus_northwind'));
    }
  });

  it('refuses an intent made for another checkout', async () => {
    const other = stripe.authorizedIntent(4000, 'usd', { checkout_id: 'chk_b' });
    const r = await authorizePayment(
      env,
      hostedOrder('ord_h_other', {
        total: 40,
        payment: { provider: 'stripe', intentId: other.id },
      }),
      'authorize#1',
      'card',
    );
    expect(r).toMatchObject({ status: 'declined' });
    expect(r.reason).toMatch(/belongs to checkout chk_b/);
    const mine = stripe.authorizedIntent(4000, 'usd', { checkout_id: 'chk_a' });
    expect(
      await authorizePayment(
        env,
        hostedOrder('ord_h_mine', { payment: { provider: 'stripe', intentId: mine.id } }),
        'authorize#1',
        'card',
      ),
    ).toMatchObject({ status: 'authorized' });
  });
});

describe('what the sweep trusts of Stripe', () => {
  /** A checkout claimed with a card that needs the bank, then the intent changed under it. */
  async function waiting(token: string) {
    const b = await ready();
    await pay(b, token);
    const id = [...stripe.intents.keys()].at(-1)!;
    return { b, id, pi: stripe.intents.get(id)! };
  }
  const sweep = async (b: Buyer) => {
    await rewindSession(b, longAgo());
    return settleOrphanedHolds(env, Date.now());
  };

  it('does not place an order on, or release, an intent that names another checkout', async () => {
    const { b, id, pi } = await waiting('ctoken_authenticate5a');
    pi.metadata.checkout_id = 'chk_somebody_else';
    stripe.authenticate(id, 'succeed');
    await sweep(b);
    expect(await view(b)).toMatchObject({ status: 'ready_for_complete' });
    expect(await orderRows(b.id)).toEqual([]);
    expect(pi.status).toBe('requires_capture');
  });

  it('releases an intent for another amount or currency, and places no order', async () => {
    for (const [token, tamper] of [
      ['ctoken_authenticate5b', (p: { amount: number }) => (p.amount += 100)],
      ['ctoken_authenticate5c', (p: { currency: string }) => (p.currency = 'eur')],
    ] as const) {
      const { b, id, pi } = await waiting(token);
      tamper(pi as never);
      stripe.authenticate(id, 'succeed');
      await sweep(b);
      expect(pi.status).toBe('canceled');
      expect(await view(b)).toMatchObject({ status: 'ready_for_complete' });
      expect(await orderRows(b.id)).toEqual([]);
    }
  });
});

describe('a payment nothing can settle', () => {
  it('is let go of after MAX_FAILED_SWEEPS sweeps that fail, and the session reopened', async () => {
    const b = await ready();
    await pay(b, 'ctoken_authenticate7a');
    const id = [...stripe.intents.keys()][0]!;
    await rewindSession(b, longAgo());
    for (let i = 1; i <= MAX_FAILED_SWEEPS; i++) {
      stripe.failNext(/\/v1\/payment_intents\//);
      const r = await settleOrphanedHolds(env, Date.now() + i * 3_600_000);
      expect(r.failed).toBeGreaterThanOrEqual(1);
      if (i < MAX_FAILED_SWEEPS) expect((await view(b)).status).toBe('complete_in_progress');
    }
    expect(await view(b)).toMatchObject({
      status: 'ready_for_complete',
      issues: [expect.objectContaining({ code: 'payment_failed' })],
    });
    expect(stripe.intents.get(id)!.status).toBe('canceled');
  });

  it('is reopened at once when Stripe will never find its hold again', async () => {
    const b = await ready();
    const c = await view(b);
    const token = 'ctoken_spent00001';
    // The token was spent on another request (so replaying the creation under this key is refused for good).
    const amount = toMinor(c.quote!.total, c.currency);
    await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'someone-elses-key' },
      body: new URLSearchParams({
        amount: String(amount),
        currency: 'usd',
        capture_method: 'manual',
        confirm: 'true',
        confirmation_token: token,
      }).toString(),
    });
    await rewindSession(b, longAgo(), {
      status: 'complete_in_progress',
      payment: { attempts: 1, token },
    });
    const r = await settleOrphanedHolds(env, Date.now());
    expect(r.released).toBeGreaterThanOrEqual(1);
    expect(await view(b)).toMatchObject({ status: 'ready_for_complete' });
  });
});
