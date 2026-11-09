import type { Order } from '@commerceworker/core';
import {
  FakePaymentProcessor,
  InMemoryBalanceStore,
  InMemoryInvoiceStore,
  InMemoryPaymentLedger,
  paymentModeFor,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it, vi } from 'vitest';
import { issueInvoice, settleInvoice, voidInvoices } from '../src/commerce';

let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };
const NOW = Date.UTC(2026, 10, 1);

const order = (id: string) =>
  ({
    id,
    title: 'Order',
    customerId: 'ada',
    currency: 'USD',
    lines: [{ sku: 'TEE', name: 'Tee', qty: 2, unitPrice: 50 }],
    subtotal: 100,
    shipping: 10,
    tax: 8,
    total: 118,
    meta: {},
  }) as unknown as Order;

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
  return {
    ledger,
    mode: paymentModeFor(processor),
    invoices: new InMemoryInvoiceStore(ledger, clock),
    balances: new InMemoryBalanceStore({ customers: [{ id: 'ada', balance: 0 }] }),
  };
}

const opts = { terms: 'net_30', sendEmail: true, onAccount: false };

describe('invoices', () => {
  it('records a mock invoice when payments are not live', async () => {
    const row = await issueInvoice(ports(), order('o1'), 'invoice#1', opts, NOW);
    expect(row).toMatchObject({ provider: 'mock', status: 'open', dueAt: NOW + 30 * 86_400_000 });
  });

  it('issues once at the processor: draft, items, finalize, send', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const row = await issueInvoice(p, order('o2'), 'invoice#1', opts, NOW);
    expect(row).toMatchObject({ status: 'open', externalId: 'in_1', number: 'INV-in_1' });
    expect(fake.invoices.invoices.get('in_1')).toEqual({
      status: 'open',
      items: [10000, 1000, 800],
      sent: true,
      paidBy: [],
    });
    expect(await issueInvoice(p, order('o2'), 'invoice#1', opts, NOW + 1)).toEqual(row);
    expect(fake.invoices.invoices.get('in_1')?.items).toHaveLength(3);
  });

  it('settles a paid invoice once, with its payment and account charge', async () => {
    const p = ports(new FakePaymentProcessor());
    const row = await issueInvoice(p, order('o3'), 'invoice#1', { ...opts, onAccount: true }, NOW);
    await p.balances.charge({
      orderId: 'o3',
      stepKey: 'invoice#1',
      customerId: 'ada',
      amount: 118,
    });
    const s = await settleInvoice(p, row.externalId!);
    expect(s).toMatchObject({ invoiceId: row.id, settled: true });
    expect(await settleInvoice(p, row.externalId!)).toMatchObject({ settled: false });
    expect(await p.balances.balance('ada')).toBe(0);
    expect((await p.ledger.forOrder('o3')).map((x) => [x.kind, x.amount])).toEqual([
      ['invoice_payment', 118],
    ]);
    expect(await settleInvoice(p, 'in_elsewhere')).toBeNull();
  });

  it('records the PaymentIntent that paid the invoice, so a refund can reach it', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const settle = (id: string) => settleInvoice({ ...p, processor: fake.invoices }, id);
    const paidOnce = await issueInvoice(p, order('o5'), 'invoice#1', opts, NOW);
    fake.invoices.pay(paidOnce.externalId!, [{ intentId: 'pi_whole', amount: 11800 }]);
    await settle(paidOnce.externalId!);
    expect((await p.ledger.forOrder('o5')).map((x) => [x.kind, x.externalId, x.ref])).toEqual([
      ['invoice_payment', 'pi_whole', paidOnce.id],
    ]);
    // In parts, partly outside the processor, or without the processor at hand: by the invoice.
    const cases: [string, { intentId: string; amount: number }[] | null][] = [
      [
        'o6',
        [
          { intentId: 'pi_a', amount: 5000 },
          { intentId: 'pi_b', amount: 6800 },
        ],
      ],
      ['o7', [{ intentId: 'pi_part', amount: 5000 }]],
      ['o8', []],
      ['o9', null],
    ];
    for (const [id, by] of cases) {
      const row = await issueInvoice(p, order(id), 'invoice#1', opts, NOW);
      if (by) fake.invoices.pay(row.externalId!, by);
      await (by ? settle(row.externalId!) : settleInvoice(p, row.externalId!));
      expect((await p.ledger.forOrder(id)).map((x) => x.externalId)).toEqual([row.externalId]);
    }
  });

  it("settles by the invoice when the processor can't say what paid it", async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const row = await issueInvoice(p, order('o10'), 'invoice#1', { ...opts, onAccount: true }, NOW);
    await p.balances.charge({
      orderId: 'o10',
      stepKey: 'invoice#1',
      customerId: 'ada',
      amount: 118,
    });
    const down = Object.assign(Object.create(fake.invoices), {
      payments: async () => {
        throw new Error('Stripe is down');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await settleInvoice({ ...p, processor: down }, row.externalId!)).toMatchObject({
      settled: true,
    });
    warn.mockRestore();
    expect((await p.ledger.forOrder('o10')).map((x) => x.externalId)).toEqual([row.externalId]);
    expect(await p.balances.balance('ada')).toBe(0);
  });

  it('voids unpaid invoices at the processor and leaves a paid one', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const open = await issueInvoice(p, order('o4'), 'invoice#1', opts, NOW);
    const paid = await issueInvoice(p, order('o4'), 'invoice#2', opts, NOW);
    await settleInvoice(p, paid.externalId!);
    expect(await voidInvoices(p, 'o4')).toEqual({ voided: 1, paid: [paid.number] });
    expect(fake.invoices.invoices.get(open.externalId!)?.status).toBe('void');
    expect(await voidInvoices(p, 'o4')).toEqual({ voided: 0, paid: [paid.number] });
  });

  it('keeps an invoice the processor reports paid when voiding it', async () => {
    const fake = new FakePaymentProcessor();
    const p = ports(fake);
    const row = await issueInvoice(p, order('o5'), 'invoice#1', opts, NOW);
    fake.invoices.invoices.get(row.externalId!)!.status = 'paid';
    expect(await voidInvoices(p, 'o5')).toEqual({ voided: 0, paid: [row.number] });
    expect((await p.invoices.find(row.id))?.status).toBe('open');
  });
});
