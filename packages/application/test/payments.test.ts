import type { Order } from '@commerceworker/core';
import {
  FakePaymentProcessor,
  InMemoryPaymentLedger,
  paymentModeFor,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  authorizePayment,
  capturePayment,
  charge,
  ensureProcessorCustomer,
  markIntentCanceled,
  orderForIntent,
  paidAmount,
  paySupplier,
  reconcileCapture,
  reconcileRefund,
  refund,
  refundedAmount,
  voidAuthorizations,
} from '../src/commerce';

let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };

const order = (id: string, over: Partial<Order> = {}) =>
  ({ id, total: 100, currency: 'USD', lines: [], meta: {}, customerId: 'ada', ...over }) as Order;

function ports(processor?: FakePaymentProcessor) {
  const ledger = new InMemoryPaymentLedger(
    {
      customers: [
        {
          id: 'ada',
          name: 'Ada',
          email: 'ada@example.com',
          stripeCustomerId: null,
          paymentMethodId: null,
        },
      ],
    },
    clock,
  );
  return { ledger, mode: paymentModeFor(processor) };
}

describe('payments in mock mode', () => {
  it('records the authorization once and simulates a decline', async () => {
    const p = ports();
    const a = await authorizePayment(p, order('o1'), 'authorize#1', 'card');
    expect(a).toEqual({ paymentId: 'pay_o1_authorize_1', amount: 100, status: 'authorized' });
    expect(await authorizePayment(p, order('o1', { total: 5 }), 'authorize#1', 'card')).toEqual(a);
    const d = await authorizePayment(
      p,
      order('o2', { meta: { simulate: 'payment_decline' } }),
      'authorize#1',
      'card',
    );
    expect(d.status).toBe('declined');
  });
});

describe('payments through the processor', () => {
  it('authorizes, captures no more than the order now costs, once', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const a = await authorizePayment(p, order('o3'), 'authorize#1', 'card');
    expect(a).toMatchObject({ status: 'authorized', intentId: 'pi_1' });
    const c = await capturePayment(p, order('o3', { total: 80 }), 'capture#1');
    expect(c).toEqual({ paymentId: 'cap_capture_1_o3', amount: 80, status: 'succeeded' });
    expect(await capturePayment(p, order('o3', { total: 80 }), 'capture#1')).toEqual(c);
    expect(await paidAmount(p, 'o3')).toBe(80);
    expect(fake.calls.filter((x) => x.startsWith('capture'))).toHaveLength(1);
  });

  it('records a declined card as declined, with its reason', async () => {
    const p = ports(new FakePaymentProcessor());
    const d = await authorizePayment(
      p,
      order('o4', { meta: { simulate: 'payment_decline' } }),
      'authorize#1',
      'card',
    );
    expect(d).toMatchObject({ status: 'declined', reason: 'card_declined' });
  });

  it('verifies a card, saves it, and charges it off-session later', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const v = await authorizePayment(p, order('o5'), 'authorize#1', 'card', 'verify');
    expect(v.status).toBe('verified');
    expect(fake.intents.get(v.intentId!)?.status).toBe('canceled');
    expect(await p.ledger.customer('ada')).toMatchObject({
      paymentMethodId: 'pm_card_visa',
      stripeCustomerId: expect.stringMatching(/^cus_/),
    });
    const c = await charge(p, order('o5'), 'charge#1');
    expect(c.status).toBe('succeeded');
  });

  it('voids open authorizations once, leaving one already captured to the capture', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const a = await authorizePayment(p, order('o6'), 'authorize#1', 'card');
    expect(await voidAuthorizations(p, 'o6')).toBe(1);
    expect(await voidAuthorizations(p, 'o6')).toBe(0);

    const b = await authorizePayment(p, order('o7'), 'authorize#1', 'card');
    fake.intents.get(b.intentId!)!.status = 'succeeded';
    expect(await voidAuthorizations(p, 'o7')).toBe(0);
    expect(await capturePayment(p, order('o7'), 'capture#1')).toMatchObject({
      status: 'succeeded',
    });
    expect(a.intentId).not.toBe(b.intentId);
  });

  it('spreads a refund over the charges newest first, once per step', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    await charge(p, order('o8', { total: 30 }), 'charge#1');
    await charge(p, order('o8', { total: 20 }), 'charge#2');
    const r = await refund(p, order('o8'), 'refund#1', 35);
    expect(r).toEqual({ paymentId: 'rfd_o8_refund_1', amount: 35, status: 'succeeded' });
    expect([...fake.refunds.values()].map((x) => x.amount)).toEqual([2000, 1500]);
    expect(await refund(p, order('o8'), 'refund#1', 35)).toEqual(r);
    expect(fake.refunds.size).toBe(2);
  });
});

describe('the processor around a payment', () => {
  it("creates the account's processor customer once and keeps it; a guest's is never stored", async () => {
    const fake = new FakePaymentProcessor();
    const { ledger } = ports(fake);
    const first = await ensureProcessorCustomer(ledger, fake, order('o20'));
    expect(await ensureProcessorCustomer(ledger, fake, order('o21'))).toBe(first);
    expect((await ledger.customer('ada'))?.stripeCustomerId).toBe(first);
    // One given on the order wins.
    expect(
      await ensureProcessorCustomer(
        ledger,
        fake,
        order('o22', { payment: { stripeCustomerId: 'cus_given' } } as never),
      ),
    ).toBe('cus_given');
    const guest = await ensureProcessorCustomer(
      ledger,
      fake,
      order('o23', { customerId: undefined }),
    );
    expect(guest).not.toBe(first);
    expect(fake.customers.size).toBe(2);
  });

  it('finds the order an intent pays, and voids its hold when the processor cancels it', async () => {
    const p = ports(new FakePaymentProcessor());
    const a = await authorizePayment(p, order('o24'), 'authorize#1', 'card');
    const intent = (a as { intentId: string }).intentId;
    expect(await orderForIntent(p, intent)).toBe('o24');
    expect(await orderForIntent(p, 'pi_unknown')).toBeNull();
    expect(await markIntentCanceled(p, intent)).toEqual(['o24']);
    // Canceled again: nothing left open to void.
    expect(await markIntentCanceled(p, intent)).toEqual([]);
    expect(await capturePayment(p, order('o24'), 'capture#1')).toMatchObject({ status: 'failed' });
  });

  it('records a supplier payment without the processor, once per step, and sums refunds', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const paid = await paySupplier(p, order('o25', { total: 40 }), 'pay_supplier#1');
    expect(paid).toMatchObject({ amount: 40, status: 'succeeded' });
    expect(await paySupplier(p, order('o25', { total: 40 }), 'pay_supplier#1')).toEqual(paid);
    expect(fake.calls).toEqual([]);
    expect(await refundedAmount(p, 'o25')).toBe(0);
    await charge(p, order('o26', { total: 30 }), 'charge#1');
    await refund(p, order('o26'), 'refund#1', 12);
    expect(await refundedAmount(p, 'o26')).toBe(12);
  });
});

describe('reconciling what the processor did', () => {
  it('records a dashboard capture, and the capture step then finds it rather than failing', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const a = await authorizePayment(p, order('o_rc1'), 'authorize#1', 'card');
    fake.intents.get(a.intentId!)!.status = 'succeeded';
    expect(await reconcileCapture(p, a.intentId!, 10000)).toEqual({
      status: 'recorded',
      orderId: 'o_rc1',
    });
    expect(await reconcileCapture(p, a.intentId!, 10000)).toMatchObject({ status: 'known' });
    expect(await paidAmount(p, 'o_rc1')).toBe(100);
    // The flow's own capture step runs after: the money is taken, so it succeeds, once.
    expect(await capturePayment(p, order('o_rc1'), 'capture#1')).toMatchObject({
      status: 'succeeded',
      amount: 100,
    });
    expect(await paidAmount(p, 'o_rc1')).toBe(100);
    expect(await reconcileCapture(p, 'pi_unknown', 100)).toEqual({ status: 'unknown' });
  });

  it('records a dashboard refund once, leaves ours alone and reports one it cannot place', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const a = await authorizePayment(p, order('o_rc2'), 'authorize#1', 'card');
    const re = (id: string, metadata = {}) => ({ id, amount: 2500, status: 'succeeded', metadata });
    // Nothing is captured yet: the capture's event may still come, so the refund waits for it.
    expect(await reconcileRefund(p, a.intentId!, re('re_early'))).toMatchObject({
      status: 'retry',
    });
    await capturePayment(p, order('o_rc2'), 'capture#1');
    expect(await reconcileRefund(p, a.intentId!, re('re_dash'))).toEqual({
      status: 'recorded',
      orderId: 'o_rc2',
    });
    expect(await reconcileRefund(p, a.intentId!, re('re_dash'))).toMatchObject({ status: 'known' });
    // One of ours (it names its row) is recorded there once, not under a dashboard id.
    expect(
      await reconcileRefund(p, a.intentId!, re('re_ours', { payment_id: 'x', row_id: 'rfd_ours' })),
    ).toMatchObject({ status: 'recorded' });
    expect((await p.ledger.find('rfd_ours'))?.externalId).toBe('re_ours');
    expect(await p.ledger.find('rfd_stripe_re_ours')).toBeUndefined();
    expect(
      await reconcileRefund(p, a.intentId!, { ...re('re_wait'), status: 'pending' }),
    ).toMatchObject({ status: 'known' });
    expect(await refundedAmount(p, 'o_rc2')).toBe(50);
  });

  it('declines an intent another order claimed first', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const a = await authorizePayment(p, order('o_rc3'), 'authorize#1', 'card');
    // An intent made elsewhere names no order of ours.
    fake.intents.get(a.intentId!)!.metadata = {};
    // Lose the race adoptProblem can't see: its look finds nothing, then the claim is taken.
    const looks = p.ledger.forExternalId.bind(p.ledger);
    let first = true;
    p.ledger.forExternalId = async (id) => {
      if (first) {
        first = false;
        return [];
      }
      return looks(id);
    };
    const adopted = order('o_rc4', { payment: { provider: 'stripe', intentId: a.intentId } });
    expect(await authorizePayment(p, adopted, 'authorize#1', 'card')).toMatchObject({
      status: 'declined',
      reason: 'PaymentIntent already pays order o_rc3',
    });
  });
});

describe('a capture step and the captures that are not its own', () => {
  it('does not report one authorization’s capture as another’s', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    await authorizePayment(p, order('o_two'), 'authorize#1', 'card');
    const first = await capturePayment(p, order('o_two'), 'capture#1');
    expect(first.status).toBe('succeeded');
    // The second run's authorization is declined, so there is nothing for capture#2 to take.
    const declined = await authorizePayment(
      p,
      order('o_two', { meta: { simulate: 'payment_decline' } }),
      'authorize#2',
      'card',
    );
    expect(declined.status).toBe('declined');
    expect(await capturePayment(p, order('o_two'), 'capture#2')).toEqual({
      paymentId: null,
      amount: 0,
      status: 'failed',
    });
    expect(await paidAmount(p, 'o_two')).toBe(100);
  });

  it('reports the capture that took its own authorization when a reconciled one won the flip', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const a = await authorizePayment(p, order('o_flip'), 'authorize#1', 'card');
    fake.intents.get(a.intentId!)!.status = 'succeeded';
    // The event's capture is recorded between the step's read and its flip.
    const real = p.ledger.capture.bind(p.ledger);
    let raced = false;
    p.ledger.capture = async (id, c) => {
      if (!raced) {
        raced = true;
        await reconcileCapture(p, a.intentId!, 10000);
      }
      return real(id, c);
    };
    expect(await capturePayment(p, order('o_flip'), 'capture#1')).toMatchObject({
      paymentId: `cap_stripe_${a.intentId}`,
      status: 'succeeded',
    });
  });
});

describe('a refund whose answer was lost', () => {
  it('is recorded from the processor under the step’s own row, and the retried step finds it', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    await authorizePayment(p, order('o_lost'), 'authorize#1', 'card');
    await capturePayment(p, order('o_lost'), 'capture#1');
    // The process dies between the processor's refund and the ledger's record.
    const record = p.ledger.record.bind(p.ledger);
    let crash = true;
    p.ledger.record = async (row) => {
      if (crash && row.kind === 'refund') {
        crash = false;
        throw new Error('worker died');
      }
      return record(row);
    };
    await expect(refund(p, order('o_lost'), 'refund#1', 40)).rejects.toThrow('worker died');
    expect(await refundedAmount(p, 'o_lost')).toBe(0);

    // Its event arrives meanwhile: the refund names its row, so it is recorded there.
    const [re] = await fake.listRefunds((await p.ledger.forOrder('o_lost'))[0]!.externalId!);
    expect(re!.metadata.row_id).toBeTruthy();
    const pi = (await p.ledger.forOrder('o_lost'))[0]!.externalId!;
    expect(await reconcileRefund(p, pi, re!)).toMatchObject({ status: 'recorded' });
    expect(await refundedAmount(p, 'o_lost')).toBe(40);

    // The step retries: Stripe replays the same refund, and the row is already there.
    expect(await refund(p, order('o_lost'), 'refund#1', 40)).toMatchObject({
      status: 'succeeded',
      amount: 40,
    });
    expect(await refundedAmount(p, 'o_lost')).toBe(40);
    expect((await p.ledger.forOrder('o_lost')).filter((r) => r.kind === 'refund')).toHaveLength(1);
  });

  it('waits for a capture that has not been applied, and treats a lost one as a mismatch', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const a = await authorizePayment(p, order('o_wait'), 'authorize#1', 'card');
    const re = { id: 're_w', amount: 1000, status: 'succeeded', metadata: {} };
    expect(await reconcileRefund(p, a.intentId!, re)).toEqual({
      status: 'retry',
      orderId: 'o_wait',
    });
    await voidAuthorizations(p, 'o_wait');
    expect(await reconcileRefund(p, a.intentId!, re)).toMatchObject({ status: 'mismatch' });
  });
});
