import { describe, expect, it } from 'vitest';
import {
  fromMinor,
  isInvoicePaidByIntent,
  minorUnitFactor,
  orderInputSchema,
  type PaymentSource,
  paidTotal,
  paymentSource,
  planRefund,
  refundableTotal,
  refundedTotal,
  toMinor,
} from '../src';

describe('money in minor units', () => {
  it('uses cents for most currencies and whole units for zero-decimal ones', () => {
    expect(toMinor(12.34, 'USD')).toBe(1234);
    expect(toMinor(0.1 + 0.2, 'EUR')).toBe(30);
    expect(toMinor(19.999, 'usd')).toBe(2000);
    expect(toMinor(1200, 'JPY')).toBe(1200);
    expect(toMinor(1200.4, 'KRW')).toBe(1200);
    expect(minorUnitFactor('jpy')).toBe(1);
    expect(fromMinor(1234, 'USD')).toBe(12.34);
    expect(fromMinor(1200, 'JPY')).toBe(1200);
  });

  it('round-trips amounts with two decimals', () => {
    for (const n of [0, 0.01, 9.99, 1234.56, 99_999.99])
      expect(fromMinor(toMinor(n, 'GBP'), 'GBP')).toBe(n);
  });

  it('refuses a non-number', () => {
    expect(() => toMinor(Number.NaN, 'USD')).toThrow(RangeError);
  });
});

describe('paymentSource', () => {
  const saved = { stripeCustomerId: 'cus_1', paymentMethodId: 'pm_saved' };
  const cases: [string, Parameters<typeof paymentSource>, PaymentSource][] = [
    ['nothing given', [{}], 'none'],
    ['a saved card', [{}, 'card', saved], 'off_session'],
    ['a saved card without a customer', [{}, 'card', { paymentMethodId: 'pm_saved' }], 'none'],
    [
      'a customer on the order and a saved card',
      [
        { payment: { provider: 'stripe', stripeCustomerId: 'cus_2' } },
        'card',
        { paymentMethodId: 'pm_x' },
      ],
      'off_session',
    ],
    [
      'a payment method',
      [{ payment: { provider: 'stripe', paymentMethodId: 'pm_1' } }, 'card', saved],
      'confirm',
    ],
    [
      'an intent, over a payment method',
      [{ payment: { provider: 'stripe', intentId: 'pi_1', paymentMethodId: 'pm_1' } }],
      'adopt',
    ],
    ['the channel took it', [{ payment: { provider: 'external', intentId: 'pi_1' } }], 'external'],
    ['external at the till', [{ payment: { provider: 'external' } }, 'cash'], 'external'],
    ['cash', [{}, 'cash', saved], 'offline'],
    [
      'a terminal at the till',
      [{ payment: { provider: 'stripe', intentId: 'pi_1' } }, 'card_present'],
      'offline',
    ],
    ['terms', [{}, 'terms'], 'offline'],
    [
      'a wallet',
      [{ payment: { provider: 'stripe', paymentMethodId: 'pm_1' } }, 'wallet'],
      'confirm',
    ],
  ];
  it.each(cases)('%s', (_name, args, expected) => {
    expect(paymentSource(...args)).toBe(expected);
  });

  it('validates Stripe ids on the order', () => {
    const base = { model: 'b2c' as const };
    const ok = (payment: unknown) => orderInputSchema.safeParse({ ...base, payment }).success;
    expect(ok({ provider: 'stripe', intentId: 'pi_3Abc' })).toBe(true);
    expect(ok({ provider: 'stripe', intentId: 'ch_1' })).toBe(false);
    expect(ok({ provider: 'paypal' })).toBe(false);
  });
});

describe('the payments ledger arithmetic', () => {
  const pay = (id: string, kind: string, amount: number, createdAt: number, ref?: string) => ({
    id,
    kind,
    amount,
    status: 'succeeded',
    ref: ref ?? null,
    createdAt,
  });

  it('totals what was paid, refunded and is still refundable', () => {
    const rows = [
      pay('cap', 'capture', 60, 1),
      pay('chg', 'charge', 40, 2),
      pay('rfd', 'refund', 15, 3),
      { ...pay('bad', 'charge', 99, 4), status: 'failed' },
    ];
    expect([paidTotal(rows), refundedTotal(rows), refundableTotal(rows)]).toEqual([100, 15, 85]);
  });

  it('spreads a refund over payments newest first, net of earlier refunds', () => {
    const rows = [
      pay('cap', 'capture', 60, 1),
      pay('chg', 'charge', 40, 2),
      pay('r1', 'refund', 30, 3, 'chg'),
      pay('r2', 'refund', 5, 4),
    ];
    // chg holds 10 after its own refund; the unattributed 5 comes off it too, leaving 5.
    expect(planRefund(rows, 50).map((p) => [p.payment.id, p.amount])).toEqual([
      ['chg', 5],
      ['cap', 45],
    ]);
    expect(planRefund(rows).map((p) => p.amount)).toEqual([5, 60]);
    expect(planRefund([pay('cap', 'capture', 10, 1), pay('r', 'refund', 10, 2)])).toEqual([]);
  });

  it('refunds an invoice payment once it names the PaymentIntent that paid it', () => {
    const invoice = (id: string, externalId: string, provider = 'stripe') => ({
      ...pay(id, 'invoice_payment', 80, 5),
      provider,
      externalId,
    });
    const byIntent = invoice('ipay_a', 'pi_123');
    const byInvoice = invoice('ipay_b', 'in_456');
    expect(isInvoicePaidByIntent(byIntent)).toBe(true);
    expect(isInvoicePaidByIntent(byInvoice)).toBe(false);
    expect(isInvoicePaidByIntent({ ...byIntent, status: 'failed' })).toBe(false);
    // Fails closed: an invoice payment that doesn't say it is Stripe's isn't counted.
    expect(isInvoicePaidByIntent({ ...byIntent, provider: undefined })).toBe(false);
    expect(isInvoicePaidByIntent(invoice('ipay_c', 'pi_789', 'mock'))).toBe(false);

    // An order paid only by invoice: refundable through its PaymentIntent, newest first.
    const onlyInvoices = [invoice('ipay_old', 'pi_old'), byInvoice, { ...byIntent, createdAt: 6 }];
    expect(paidTotal(onlyInvoices)).toBe(160);
    expect(planRefund(onlyInvoices, 100).map((p) => [p.payment.id, p.amount])).toEqual([
      ['ipay_a', 80],
      ['ipay_old', 20],
    ]);
  });

  it('never counts the same money twice: an order also captured counts only the capture', () => {
    // Authorized and captured on terms, then collected by a Stripe invoice.
    const rows = [
      { ...pay('cap', 'capture', 80, 1), provider: 'offline' },
      { ...pay('ipay', 'invoice_payment', 80, 2), provider: 'stripe', externalId: 'pi_1' },
    ];
    expect([paidTotal(rows), refundableTotal(rows)]).toEqual([80, 80]);
    expect(planRefund(rows).map((p) => [p.payment.id, p.amount])).toEqual([['cap', 80]]);
  });
});
