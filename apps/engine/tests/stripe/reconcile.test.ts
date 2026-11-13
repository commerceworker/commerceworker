import { env } from 'cloudflare:workers';
import type { Order } from '@commerceworker/core';
import { createDb, payments } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAIM_STALE_MS, handleStripeEvent } from '../../src/payment-events';
import { POISON_AFTER, reconcileStripe } from '../../src/payment-reconcile';
import { authorizePayment, capturePayment, refund, voidAuthorizations } from '../../src/payments';
import { paymentEventLog } from '../../src/wire';
import { installStripeFake, type StripeFake } from '../stripe-fake';

const db = () => createDb(env.DB);
const rows = (orderId: string) =>
  db().select().from(payments).where(eq(payments.orderId, orderId)).all();
const order = (id: string, intentId: string): Order => ({
  id,
  channel: 'api',
  model: 'b2c',
  currency: 'USD',
  lines: [],
  meta: {},
  customerId: 'cus_ada',
  createdAt: Date.now(),
  subtotal: 40,
  shipping: 0,
  tax: 0,
  total: 40,
  payment: { provider: 'stripe', intentId },
});
const asEvent = (e: { id: string; type: string; data: unknown }) =>
  ({ provider: 'stripe', id: e.id, type: e.type, data: e.data }) as Parameters<
    typeof handleStripeEvent
  >[1];

/** An order holding a Stripe authorization for $40, adopted from an intent made elsewhere. */
async function authorized(stripe: StripeFake, id: string) {
  const pi = stripe.authorizedIntent(4000);
  const o = order(id, pi.id);
  await authorizePayment(env, o, 'authorize#1', 'card');
  return { o, pi };
}

let stripe: StripeFake;
beforeEach(() => {
  stripe = installStripeFake();
});
afterEach(() => {
  stripe.restore();
  vi.restoreAllMocks();
});

describe('Stripe reconciliation', () => {
  it('applies a dropped webhook once: a capture made in the dashboard reaches the ledger', async () => {
    const { o, pi } = await authorized(stripe, 'ord_rc_cap');
    stripe.dashboardCapture(pi.id);
    expect((await rows(o.id)).map((r) => r.status)).toEqual(['authorized']);

    const first = await reconcileStripe(env);
    expect(first).toMatchObject({ handled: expect.any(Number), mismatched: 0, failed: 0 });
    const after = await rows(o.id);
    expect(after.find((r) => r.kind.startsWith('authorization'))?.status).toBe('captured');
    const capture = after.filter((r) => r.kind === 'capture');
    expect(capture).toHaveLength(1);
    expect(capture[0]).toMatchObject({ amount: 40, externalId: pi.id, status: 'succeeded' });

    // A second pass offers the same event again: its id is claimed, and nothing changes.
    const second = await reconcileStripe(env);
    expect(second).toMatchObject({ handled: 0 });
    expect(await rows(o.id)).toEqual(after);
  });

  it('records a dashboard refund once, from either of its events, and a replayed event is a no-op', async () => {
    const { o, pi } = await authorized(stripe, 'ord_rc_ref');
    await capturePayment(env, o, 'capture#1');
    const { refund: re, created, charged } = stripe.dashboardRefund(pi.id, 1500);

    // `refund.created` arrives by webhook; the reconciliation then offers it and `charge.refunded`.
    expect(await handleStripeEvent(env, asEvent(created))).toMatchObject({ outcome: 'handled' });
    expect(await handleStripeEvent(env, asEvent(created))).toEqual({ outcome: 'duplicate' });
    await reconcileStripe(env);
    // charge.refunded lists the refunds itself and finds this one already there.
    expect(await handleStripeEvent(env, asEvent(charged))).toMatchObject({ outcome: 'duplicate' });

    const refunds = (await rows(o.id)).filter((r) => r.kind === 'refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amount: 15,
      status: 'succeeded',
      externalId: (re as { id: string }).id,
      provider: 'stripe',
    });
  });

  it('records a dashboard refund from charge.refunded alone', async () => {
    const { o, pi } = await authorized(stripe, 'ord_rc_chg');
    await capturePayment(env, o, 'capture#1');
    const { charged } = stripe.dashboardRefund(pi.id, 4000);
    expect(await handleStripeEvent(env, asEvent(charged))).toMatchObject({
      outcome: 'handled',
      orderId: o.id,
    });
    expect((await rows(o.id)).filter((r) => r.kind === 'refund')).toMatchObject([{ amount: 40 }]);
  });

  it('leaves a refund the engine made to the step that made it', async () => {
    const { o } = await authorized(stripe, 'ord_rc_own');
    await capturePayment(env, o, 'capture#1');
    await refund(env, o, 'refund#1', 10);
    for (const re of stripe.refunds.values()) stripe.emit('refund.created', re);
    await reconcileStripe(env);
    expect((await rows(o.id)).filter((r) => r.kind === 'refund')).toHaveLength(1);
  });

  it('logs a mismatch it cannot fix at error level, once', async () => {
    // A refund of an intent we know only as a voided authorization: nothing was captured to refund.
    const { o, pi } = await authorized(stripe, 'ord_rc_mis');
    await voidAuthorizations(env, o.id);
    stripe.emit('refund.created', {
      id: 're_mismatch_1',
      object: 'refund',
      amount: 1000,
      status: 'succeeded',
      payment_intent: pi.id,
      metadata: {},
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = await reconcileStripe(env);
    expect(first).toMatchObject({ mismatched: 1 });
    expect(err.mock.calls.some((c) => String(c[0]).includes('stripe_reconcile_mismatch'))).toBe(
      true,
    );
    expect((await rows(o.id)).filter((r) => r.kind === 'refund')).toHaveLength(0);
    // Claimed, so the next hour does not shout about it again.
    expect(await reconcileStripe(env)).toMatchObject({ mismatched: 0 });
  });

  it('holds the cursor at an event whose handling failed, and applies it next time', async () => {
    const { o, pi } = await authorized(stripe, 'ord_rc_fail');
    await capturePayment(env, o, 'capture#1');
    const { charged, created } = stripe.dashboardRefund(pi.id, 2000);
    // Only `charge.refunded` is left to find, and it has to ask Stripe for the refund, which fails.
    stripe.events.splice(stripe.events.indexOf(created), 1);
    stripe.failNext(/\/v1\/refunds/);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(reconcileStripe(env)).rejects.toThrow(/1 events failed/);
    expect(err.mock.calls.some((c) => String(c[0]).includes('stripe_reconcile_failed'))).toBe(true);
    expect((await rows(o.id)).filter((r) => r.kind === 'refund')).toHaveLength(0);
    expect((await paymentEventLog(env).cursor('stripe'))! * 1000).toBeLessThanOrEqual(
      charged.created * 1000,
    );

    // The claim was given back, so the next pass applies it.
    await reconcileStripe(env);
    expect((await rows(o.id)).filter((r) => r.kind === 'refund')).toMatchObject([{ amount: 20 }]);
  });
});

describe('events without an amount', () => {
  it('are ignored, not applied as zero', async () => {
    const { pi } = await authorized(stripe, 'ord_rc_noamt');
    const succeeded = stripe.emit('payment_intent.succeeded', {
      id: pi.id,
      object: 'payment_intent',
    });
    const refunded = stripe.emit('refund.created', {
      id: 're_noamt',
      object: 'refund',
      status: 'succeeded',
      payment_intent: pi.id,
      metadata: {},
    });
    expect(await handleStripeEvent(env, asEvent(succeeded))).toMatchObject({ outcome: 'ignored' });
    expect(await handleStripeEvent(env, asEvent(refunded))).toMatchObject({ outcome: 'ignored' });
    expect((await rows('ord_rc_noamt')).map((r) => r.status)).toEqual(['authorized']);
  });
});

describe('ordering and windows', () => {
  it('waits for the capture a refund depends on, whatever order the events arrive in', async () => {
    const { o, pi } = await authorized(stripe, 'ord_rc_order');
    const cap = stripe.dashboardCapture(pi.id);
    const { created, charged } = stripe.dashboardRefund(pi.id, 1000);
    // All four in one second, as a busy account's can be.
    const T = Math.floor(Date.now() / 1000);
    for (const e of [cap, created, charged]) e.created = T;

    // The refund's events come by webhook before the capture's: neither is lost, neither is a mismatch.
    expect(await handleStripeEvent(env, asEvent(created))).toMatchObject({ outcome: 'retry' });
    expect(await handleStripeEvent(env, asEvent(charged))).toMatchObject({ outcome: 'retry' });
    expect(await handleStripeEvent(env, asEvent(cap))).toMatchObject({ outcome: 'handled' });
    expect((await rows(o.id)).filter((r) => r.kind === 'refund')).toHaveLength(0);
    // Stripe offers them again (a retry is released, not claimed).
    expect(await handleStripeEvent(env, asEvent(created))).toMatchObject({ outcome: 'handled' });
    expect(await handleStripeEvent(env, asEvent(charged))).toMatchObject({
      outcome: 'handled',
      reason: 'Already in the ledger',
    });
    expect((await rows(o.id)).filter((r) => r.kind === 'refund')).toMatchObject([{ amount: 10 }]);
  });

  it('applies events that share one second in the order Stripe made them', async () => {
    const { o, pi } = await authorized(stripe, 'ord_rc_tie');
    const cap = stripe.dashboardCapture(pi.id);
    const { created } = stripe.dashboardRefund(pi.id, 1000);
    const T = Math.floor(Date.now() / 1000);
    for (const e of [cap, created]) e.created = T;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Listed newest first (the refund, then the capture): reversed, the capture goes first.
    expect(await reconcileStripe(env)).toMatchObject({ mismatched: 0, failed: 0, unresolved: 0 });
    expect(err.mock.calls.some((c) => String(c[0]).includes('mismatch'))).toBe(false);
    expect((await rows(o.id)).filter((r) => r.kind === 'refund')).toHaveLength(1);
  });

  it('skips nothing when there are more events than the page cap reads', async () => {
    // 450 events over 90 seconds from where the cursor is, with pages of 100 and a cap of two pages.
    const base = (await paymentEventLog(env).cursor('stripe')) ?? Math.floor(Date.now() / 1000);
    const later = (base + 10_000) * 1000;
    const ids: string[] = [];
    for (let i = 0; i < 450; i++)
      ids.push(
        stripe.emit(
          'payment_intent.succeeded',
          { id: `pi_cap_${i}`, object: 'payment_intent', amount_received: 100 },
          base + Math.floor(i / 5),
        ).id,
      );
    const claimed = async () => {
      const log = paymentEventLog(env);
      const out: boolean[] = [];
      // A claim that succeeds means it was never handled: give it straight back.
      for (const id of ids) {
        const fresh =
          (await log.claim(id, 'stripe', 'payment_intent.succeeded', 1, 0)) === 'claimed';
        if (fresh) await log.release(id);
        out.push(!fresh);
      }
      return out;
    };
    let passes = 0;
    while (!(await claimed()).every(Boolean) && passes < 20) {
      await reconcileStripe(env, later, 2);
      passes++;
    }
    expect((await claimed()).every(Boolean)).toBe(true);
    // More than one pass was needed, and the cursor ended past the events.
    expect(passes).toBeGreaterThan(1);
  });
});

describe('one claim per PaymentIntent', () => {
  it('refuses a second authorization row for one intent', async () => {
    const { pi } = await authorized(stripe, 'ord_rc_uniq_a');
    const dup = {
      id: 'pay_dup_row',
      orderId: 'ord_rc_uniq_b',
      kind: 'authorization:card',
      amount: 40,
      status: 'authorized',
      provider: 'stripe',
      externalId: pi.id,
      createdAt: Date.now(),
    };
    const refused = await db()
      .insert(payments)
      .values(dup)
      .then(
        () => undefined,
        (e: Error) => String(e.cause ?? e),
      );
    expect(refused).toMatch(/UNIQUE/);
    // A declined row names the intent it refused, and a capture names its authorization's.
    await db()
      .insert(payments)
      .values({ ...dup, id: 'pay_dup_declined', status: 'declined' });
  });

  it('declines the loser when two orders adopt one intent at once', async () => {
    const pi = stripe.authorizedIntent(4000);
    const [a, b] = await Promise.all(
      ['ord_rc_race_a', 'ord_rc_race_b'].map((id) =>
        authorizePayment(env, order(id, pi.id), 'authorize#1', 'card'),
      ),
    );
    expect([a!.status, b!.status].sort()).toEqual(['authorized', 'declined']);
    const all = [...(await rows('ord_rc_race_a')), ...(await rows('ord_rc_race_b'))];
    expect(all.filter((r) => r.status === 'authorized')).toHaveLength(1);
  });
});

describe('the cursor', () => {
  it('advances the cursor, and a Stripe outage leaves it where it was', async () => {
    const log = paymentEventLog(env);
    const hour = 3_600_000;
    await reconcileStripe(env);
    const before = (await log.cursor('stripe'))!;
    expect(before).toBeGreaterThan(0);

    await reconcileStripe(env, Date.now() + hour);
    const later = (await log.cursor('stripe'))!;
    expect(later).toBeGreaterThan(before);

    stripe.failNext(/\/v1\/events/);
    await expect(reconcileStripe(env, Date.now() + 2 * hour)).rejects.toThrow();
    expect(await log.cursor('stripe')).toBe(later);
  });
});

const MIN = 60_000;

/** A time past where the shared cursor stands (earlier tests move it ahead), and events made then. */
async function afterCursor(...made: { created: number }[]) {
  const cursor = (await paymentEventLog(env).cursor('stripe')) ?? 0;
  const t0 = Math.max(Date.now(), (cursor + 2) * 1000);
  for (const e of made) e.created = Math.floor(t0 / 1000);
  return t0;
}

describe('a claim whose handler died', () => {
  it('is applied on the next delivery or pass once ten minutes have gone', async () => {
    const { o, pi } = await authorized(stripe, 'ord_rc_dead');
    const cap = stripe.dashboardCapture(pi.id);
    const t0 = await afterCursor(cap);
    // The isolate was evicted after the claim: a `processing` row and no handler.
    expect(await paymentEventLog(env).claim(cap.id, 'stripe', cap.type, t0, CLAIM_STALE_MS)).toBe(
      'claimed',
    );

    // Neither Stripe's redelivery nor the reconciliation may take it for handled meanwhile.
    expect(await handleStripeEvent(env, asEvent(cap), t0 + 9 * MIN)).toMatchObject({
      outcome: 'retry',
    });
    const early = await reconcileStripe(env, t0 + 9 * MIN);
    expect(early).toMatchObject({ unresolved: expect.any(Number), failed: 0 });
    expect((early as { unresolved: number }).unresolved).toBeGreaterThan(0);
    expect((await rows(o.id)).map((r) => r.status)).toEqual(['authorized']);

    // The pass held its cursor at the event, so the next one offers it again, and takes the claim.
    const late = await reconcileStripe(env, t0 + 11 * MIN);
    expect(late).toMatchObject({ failed: 0 });
    const after = await rows(o.id);
    expect(after.find((r) => r.kind.startsWith('authorization'))?.status).toBe('captured');
    expect(after.filter((r) => r.kind === 'capture')).toHaveLength(1);

    // Done now: a repeat is a duplicate, however long after.
    expect(await handleStripeEvent(env, asEvent(cap), t0 + 60 * MIN)).toEqual({
      outcome: 'duplicate',
    });
  });

  it('is applied by a webhook redelivery after ten minutes, and a re-run of a partly applied event changes nothing twice', async () => {
    const { o, pi } = await authorized(stripe, 'ord_rc_dead2');
    const cap = stripe.dashboardCapture(pi.id);
    const t0 = await afterCursor(cap);
    // The handler applied the capture and died before it marked the claim done.
    expect(await handleStripeEvent(env, asEvent(cap), t0)).toMatchObject({ outcome: 'handled' });
    await env.DB.prepare(
      "UPDATE payment_events SET status = 'processing', claimed_at = ?, outcome = NULL WHERE id = ?",
    )
      .bind(t0, cap.id)
      .run();
    expect(await handleStripeEvent(env, asEvent(cap), t0 + 11 * MIN)).toMatchObject({
      outcome: 'handled',
      reason: 'Already in the ledger',
    });
    expect((await rows(o.id)).filter((r) => r.kind === 'capture')).toHaveLength(1);
  });
});

describe('a poison event', () => {
  it('lets the cursor move on after five failures, and logs it once', async () => {
    const { o, pi } = await authorized(stripe, 'ord_rc_poison');
    await capturePayment(env, o, 'capture#1');
    const { charged, created } = stripe.dashboardRefund(pi.id, 2000);
    stripe.events.splice(stripe.events.indexOf(created), 1);
    // `charge.refunded` asks Stripe for the refund, which fails every time.
    const nextHourFails = () => stripe.failNext(/\/v1\/refunds/);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const poisonLines = () =>
      err.mock.calls.filter((c) => String(c[0]).includes('stripe_event_poisoned'));
    const hour = 3_600_000;
    const base = await afterCursor(charged);

    for (let n = 1; n < POISON_AFTER; n++) {
      nextHourFails();
      await expect(reconcileStripe(env, base + n * hour)).rejects.toThrow(/1 events failed/);
      // The cursor stays at the event: every hour reads Stripe's events from there again.
      expect((await paymentEventLog(env).cursor('stripe'))!).toBeLessThanOrEqual(charged.created);
    }
    expect(poisonLines()).toHaveLength(0);

    nextHourFails();
    const fifth = await reconcileStripe(env, base + POISON_AFTER * hour);
    expect(fifth).toMatchObject({ poisoned: 1, failed: 0, unresolved: 0 });
    expect(poisonLines()).toHaveLength(1);
    // Held at the event until now; with it set aside the pass is unblocked and the cursor is free to
    // move to the newest event seen (here the same second), then on with the clock.
    expect((await paymentEventLog(env).cursor('stripe'))!).toBeGreaterThanOrEqual(charged.created);

    // Set aside: later passes neither fail, nor log it again, nor stop the cursor.
    const sixth = await reconcileStripe(env, base + (POISON_AFTER + 1) * hour);
    expect(sixth).toMatchObject({ poisoned: 0, failed: 0, unresolved: 0, duplicate: 1 });
    expect(poisonLines()).toHaveLength(1);
    expect((await rows(o.id)).filter((r) => r.kind === 'refund')).toHaveLength(0);
    expect(await handleStripeEvent(env, asEvent(charged))).toMatchObject({
      outcome: 'duplicate',
      reason: 'Poisoned',
    });
  });
});
