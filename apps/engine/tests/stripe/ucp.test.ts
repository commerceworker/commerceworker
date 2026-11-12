import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { OrderState } from '@commerceworker/core';
import { payments } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { completeSession } from '../../src/checkout/complete';
import { ORPHAN_HOLD_MS, settleOrphanedHolds } from '../../src/checkout/hosted';
import { ensureTemplates, loadFlowVersion } from '../../src/flows';
import { ucpOrderCaller } from '../../src/ucp/caller';
import { STRIPE_HANDLER, ucpProfile } from '../../src/ucp/config';
import { authorizeCheckout } from '../../src/ucp/payments';
import { checkoutSessions, orderRecords } from '../../src/wire';
import { installStripeFake, type StripeFake } from '../stripe-fake';
import {
  db,
  enableUcp,
  key,
  monitorCheckout,
  ORIGIN,
  pay,
  platform,
  ucp,
  until,
} from '../ucp-helpers';

let stripe: StripeFake;
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeAll(async () => {
  await ensureTemplates(env);
  await enableUcp();
});
beforeEach(() => {
  stripe = installStripeFake();
});
afterEach(async () => {
  stripe.restore();
  await introspector?.dispose();
  introspector = undefined;
});

const stripePay = (pm: string, type = 'stripe_payment_method') => pay(pm, 'stripe', type);

describe('UCP checkout with Stripe', () => {
  it('offers the Stripe handler with the publishable key, and not the test one', async () => {
    const profile = (await ucpProfile(env, ORIGIN))!;
    expect(profile.ucp.payment_handlers).toEqual({
      'com.commerceworker.stripe': [
        expect.objectContaining({
          id: 'stripe',
          config: { publishable_key: 'pk_test_fake', credential_type: 'stripe_payment_method' },
        }),
      ],
    });
  });

  it('holds the quoted total at completion, and the order adopts and captures that hold', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const alpha = await platform('stripe_alpha');
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const total = c.totals.at(-1).amount;
    const done = await ucp(
      alpha,
      'POST',
      `/ucp/v1/checkout-sessions/${c.id}/complete`,
      stripePay('pm_card_visa'),
      { 'idempotency-key': key() },
    );
    expect(done.body.status).toBe('completed');

    const [created] = stripe.callsTo('POST', '/v1/payment_intents');
    expect(created!.params).toMatchObject({
      amount: String(total),
      currency: 'usd',
      capture_method: 'manual',
      payment_method: 'pm_card_visa',
      metadata: { checkout_id: c.id },
    });
    expect(created!.idempotencyKey).toContain(c.id);
    const intentId = [...stripe.intents.keys()][0]!;

    const orderId = done.body.order.id;
    await until(async () => {
      const s = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
      return s.status === 'waiting' ? s : false;
    }, 'the return window');
    // One PaymentIntent: the one completion made, adopted by the flow and then captured.
    expect(stripe.callsTo('POST', '/v1/payment_intents')).toHaveLength(1);
    expect(stripe.intents.get(intentId)!.status).toBe('succeeded');
    const rows = await db().select().from(payments).where(eq(payments.orderId, orderId));
    expect(rows.find((r) => r.kind === 'authorization:card')).toMatchObject({
      provider: 'stripe',
      externalId: intentId,
    });
  });

  it('reports a declined card on the checkout and places no order', async () => {
    const alpha = await platform('stripe_beta');
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const r = await ucp(
      alpha,
      'POST',
      `/ucp/v1/checkout-sessions/${c.id}/complete`,
      stripePay('pm_card_visa_chargeDeclined'),
      { 'idempotency-key': key() },
    );
    expect(r.body).toMatchObject({
      status: 'ready_for_complete',
      messages: [{ code: 'payment_failed', severity: 'recoverable', path: '$.payment' }],
    });
    expect(r.body).not.toHaveProperty('order');
  });

  it('refuses a credential that is not a Stripe PaymentMethod without calling Stripe', async () => {
    const alpha = await platform('stripe_gamma');
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const r = await ucp(
      alpha,
      'POST',
      `/ucp/v1/checkout-sessions/${c.id}/complete`,
      stripePay('tok_visa', 'card_token'),
      { 'idempotency-key': key() },
    );
    expect(r.body.messages[0]).toMatchObject({ code: 'payment_failed' });
    expect(stripe.callsTo('POST', '/v1/payment_intents')).toHaveLength(0);
  });
});

describe('a UCP checkout the Worker died in, after the hold and before the order', () => {
  const asCrashed = async (platformId: string) => {
    const alpha = await platform(platformId);
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const session = (await checkoutSessions(env).load(platformId, c.id))!;
    const flow = (await loadFlowVersion(env, 'tpl-storefront-order'))!;
    const instrument = {
      id: 'inst_1',
      handler_id: 'stripe',
      type: 'card',
      credential: { type: 'stripe_payment_method', token: 'pm_card_visa' },
    };
    // Dies where `placeOrder` first reads the caller: nothing after the hold has run, and no
    // handler of the session's gets to put it back.
    const dying = {
      ...ucpOrderCaller(platformId, c.id, ORIGIN),
      get idempotencyPrefix(): string {
        throw new Error('Worker died');
      },
    };
    await expect(
      completeSession(
        env,
        dying,
        flow,
        session,
        {
          refusal: null,
          authorize: (claimed) => authorizeCheckout(env, claimed, STRIPE_HANDLER, instrument),
        },
        { claim: { completedOn: ORIGIN } },
      ),
    ).rejects.toThrow('Worker died');
    return { id: c.id as string, owner: platformId };
  };
  const orderFor = (id: string) => orderRecords(env).byIdempotencyKey(`ucp:${id}`);
  const later = () => Date.now() + ORPHAN_HOLD_MS + 60_000;

  it('records the hold on the session, where the sweep can find it', async () => {
    const { id, owner } = await asCrashed('stripe_sweep_a');
    const [intentId] = [...stripe.intents.keys()];
    expect(await checkoutSessions(env).load(owner, id)).toMatchObject({
      status: 'complete_in_progress',
      payment: { intentId },
      completedOn: ORIGIN,
    });
    expect(await orderFor(id)).toBeUndefined();
    // Not yet: a request may still be on its way to the order.
    expect((await settleOrphanedHolds(env, Date.now())).placed).toBe(0);
    expect(await orderFor(id)).toBeUndefined();
  });

  it('is placed by the sweep, once, adopting the hold it recorded', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const { id, owner } = await asCrashed('stripe_sweep_b');
    const intentId = [...stripe.intents.keys()][0]!;
    expect(await settleOrphanedHolds(env, later())).toMatchObject({ placed: 1, failed: 0 });

    const done = (await checkoutSessions(env).load(owner, id))!;
    expect(done).toMatchObject({ status: 'completed' });
    const order = (await orderFor(id))!;
    expect(done.orderId).toBe(order.id);
    // One PaymentIntent, the one the crashed request made, and the order took it.
    expect(stripe.callsTo('POST', '/v1/payment_intents')).toHaveLength(1);
    await until(async () => {
      const state = (await env.ORDER_AGENT.getByName(order.id).snapshot()) as OrderState;
      return state.order?.payment?.intentId === intentId ? state : false;
    }, 'the order adopting the hold');
    expect(stripe.intents.get(intentId)!.status).not.toBe('canceled');

    // A second sweep finds nothing to do and places nothing again.
    expect(await settleOrphanedHolds(env, later())).toMatchObject({ placed: 0, released: 0 });
    expect(stripe.callsTo('POST', '/v1/payment_intents')).toHaveLength(1);
  });

  it('is released and reopened by the sweep, once, when the hold is no longer open', async () => {
    const { id, owner } = await asCrashed('stripe_sweep_c');
    const intentId = [...stripe.intents.keys()][0]!;
    // The bank let it go while the sweep waited.
    stripe.intents.get(intentId)!.status = 'canceled';
    expect(await settleOrphanedHolds(env, later())).toMatchObject({ released: 1, failed: 0 });

    expect(await checkoutSessions(env).load(owner, id)).toMatchObject({
      status: 'ready_for_complete',
      issues: [{ code: 'payment_failed' }],
    });
    expect(await orderFor(id)).toBeUndefined();
    expect(await settleOrphanedHolds(env, later())).toMatchObject({ placed: 0, released: 0 });
  });
});
