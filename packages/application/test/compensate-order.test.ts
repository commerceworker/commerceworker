import type { Order } from '@commerceworker/core';
import {
  FakeLabelService,
  InMemoryBalanceStore,
  InMemoryFulfillmentStore,
  InMemoryInventoryStore,
  InMemoryInvoiceStore,
  InMemoryMarketplaceStore,
  InMemoryPaymentLedger,
  InMemoryShippingStore,
  paymentModeFor,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { authorizePayment, compensateOrder, issueInvoice } from '../src/commerce';

let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };

function ports() {
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
    mode: paymentModeFor(),
    invoices: new InMemoryInvoiceStore(ledger, clock),
    balances: new InMemoryBalanceStore({ customers: [{ id: 'ada', balance: 0 }] }),
    inventory: new InMemoryInventoryStore({ products: [{ sku: 'TEE', stock: 10 }] }),
    shipping: new InMemoryShippingStore(clock),
    labels: new FakeLabelService(),
    marketplace: new InMemoryMarketplaceStore(),
    fulfillment: new InMemoryFulfillmentStore(),
  };
}

const order = {
  id: 'o1',
  customerId: 'ada',
  currency: 'USD',
  lines: [{ sku: 'TEE', qty: 2, unitPrice: 50 }],
  subtotal: 100,
  shipping: 0,
  tax: 0,
  total: 100,
  meta: {},
} as unknown as Order;

describe('cancelling an order', () => {
  it('releases its stock, voids its authorization and its invoice, once', async () => {
    const p = ports();
    await p.inventory.reserve(order, 'reserve#1');
    await authorizePayment(p, order, 'authorize#1', 'card');
    await issueInvoice(
      p,
      order,
      'invoice#1',
      { terms: 'net_30', sendEmail: false, onAccount: false },
      0,
    );
    expect((await p.inventory.levels(['TEE'])).get('TEE')).toEqual({ stock: 10, reserved: 2 });

    const undid = await compensateOrder(p, 'o1');
    expect(undid).toMatchObject({
      released: expect.any(Number),
      voided: 1,
      cancelled: 0,
      sellerOrdersCancelled: 0,
      payoutsReversed: 0,
      revoked: 0,
      invoicesVoided: 1,
      invoicesPaid: [],
      labelsNotVoided: 0,
    });
    expect(undid.released).toBeGreaterThan(0);
    expect((await p.inventory.levels(['TEE'])).get('TEE')).toEqual({ stock: 10, reserved: 0 });

    // A second cancel (a retry, or one racing the first) undoes nothing more.
    expect(await compensateOrder(p, 'o1')).toMatchObject({
      released: 0,
      voided: 0,
      invoicesVoided: 0,
    });
  });

  it('undoes nothing for an order that holds nothing', async () => {
    expect(await compensateOrder(ports(), 'o_none')).toEqual({
      released: 0,
      voided: 0,
      cancelled: 0,
      restored: 0,
      sellerOrdersCancelled: 0,
      payoutsReversed: 0,
      revoked: 0,
      unbilled: 0,
      invoicesVoided: 0,
      invoicesPaid: [],
      labelsNotVoided: 0,
    });
  });
});
