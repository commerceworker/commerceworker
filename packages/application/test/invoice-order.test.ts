import type { Order } from '@commerceworker/core';
import { FixedClock } from '@commerceworker/test-kit';
import {
  InMemoryBalanceStore,
  InMemoryDocumentStore,
  InMemoryInvoiceStore,
  InMemoryPaymentLedger,
  InMemoryPricingStore,
  PRICING_FIXTURE,
  paymentModeFor,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { invoiceOrder } from '../src/commerce';

const NOW = Date.UTC(2026, 10, 1, 15);
const clock = { now: () => new Date(NOW) };
const order = (customerId: string | undefined) =>
  ({
    id: 'o_inv',
    title: 'Order',
    customerId,
    currency: 'USD',
    lines: [{ sku: 'PC-SKU-1', qty: 2, unitPrice: 50 }],
    subtotal: 100,
    shipping: 0,
    tax: 0,
    total: 100,
    meta: {},
  }) as unknown as Order;

function ports() {
  const ledger = new InMemoryPaymentLedger({}, clock);
  return {
    ledger,
    mode: paymentModeFor(undefined),
    invoices: new InMemoryInvoiceStore(ledger, clock),
    documents: new InMemoryDocumentStore(),
    pricing: new InMemoryPricingStore(PRICING_FIXTURE, new FixedClock()),
    balances: new InMemoryBalanceStore({ customers: [{ id: 'pc_northwind', balance: 0 }] }),
  };
}
const opts = { terms: 'due_on_receipt', processor: false, sendEmail: false, onAccount: true };

describe('invoicing an order', () => {
  it('files the invoice due a day out on receipt terms, as the recorded invoice is', async () => {
    const p = ports();
    const r = await invoiceOrder(p, order('pc_northwind'), 'invoice#1', opts, NOW);
    expect(r).toMatchObject({ terms: 'due_on_receipt', due: '2026-11-02', issued: null });
    expect(await p.documents.text(r.key)).toContain('2026-11-02');
    const issued = await invoiceOrder(
      p,
      order('pc_northwind'),
      'invoice#2',
      { ...opts, processor: true },
      NOW,
    );
    expect(issued.issued?.dueAt).toBe(NOW + 86_400_000);
  });

  it('shows the buyer’s PO number on the invoice, escaped, and none for an order without one', async () => {
    const p = ports();
    const withPo = { ...order('pc_northwind'), meta: { poNumber: 'PO-77 <b>' } } as Order;
    const r = await invoiceOrder(p, withPo, 'invoice#1', opts, NOW);
    expect(await p.documents.text(r.key)).toContain('<b>PO number:</b> PO-77 &lt;b&gt;');
    const plain = await invoiceOrder(p, order('pc_northwind'), 'invoice#2', opts, NOW);
    expect(await p.documents.text(plain.key)).not.toContain('PO number');
  });

  it("charges a business customer's account once per step, unless the node keeps none", async () => {
    const p = ports();
    const r = await invoiceOrder(p, order('pc_northwind'), 'invoice#1', opts, NOW);
    expect(r.onAccount).toBe(true);
    await invoiceOrder(p, order('pc_northwind'), 'invoice#1', opts, NOW);
    expect(await p.balances.balance('pc_northwind')).toBe(100);
    const off = await invoiceOrder(
      p,
      order('pc_northwind'),
      'invoice#3',
      {
        ...opts,
        onAccount: false,
      },
      NOW,
    );
    expect(off.onAccount).toBe(false);
    expect(await p.balances.balance('pc_northwind')).toBe(100);
  });

  it('owes nothing on account for a guest', async () => {
    const p = ports();
    expect((await invoiceOrder(p, order(undefined), 'invoice#1', opts, NOW)).onAccount).toBe(false);
  });
});
