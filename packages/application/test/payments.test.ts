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
  paidAmount,
  refund,
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
