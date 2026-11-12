import type { Order } from '@commerceworker/core';
import {
  FakeLabelService,
  InMemoryBalanceStore,
  InMemoryBudgetStore,
  InMemoryFulfillmentStore,
  InMemoryInventoryStore,
  InMemoryInvoiceStore,
  InMemoryMarketplaceStore,
  InMemoryPaymentLedger,
  InMemoryPricingStore,
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
    balances: new InMemoryBalanceStore({
      customers: [{ id: 'ada', balance: 0, creditLimit: 500 }],
    }),
    budgets: new InMemoryBudgetStore(),
    inventory: new InMemoryInventoryStore({ products: [{ sku: 'TEE', stock: 10 }] }),
    shipping: new InMemoryShippingStore(clock),
    labels: new FakeLabelService(),
    marketplace: new InMemoryMarketplaceStore(),
    fulfillment: new InMemoryFulfillmentStore(),
    pricing: new InMemoryPricingStore({}, clock),
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

    const undid = await compensateOrder(p, 'o1', 1);
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
    expect(await compensateOrder(p, 'o1', 1)).toMatchObject({
      released: 0,
      voided: 0,
      invoicesVoided: 0,
    });
  });

  it('gives back the credit it holds, once, and leaves a charged hold charged', async () => {
    const p = ports();
    const hold = (orderId: string) =>
      p.balances.hold({
        orderId,
        stepKey: 'credit#1',
        customerId: 'ada',
        amount: 200,
        expiresAt: 9e15,
      });
    await hold('o1');
    await hold('o2');
    expect((await p.balances.account('ada'))?.held).toBe(400);
    expect(await compensateOrder(p, 'o1')).toMatchObject({ creditReleased: 1 });
    expect(await compensateOrder(p, 'o1')).toMatchObject({ creditReleased: 0 });
    expect((await p.balances.account('ada'))?.held).toBe(200);
    // An invoice converted o2's hold: cancelling reverses the charge and releases nothing.
    await p.balances.charge({
      orderId: 'o2',
      stepKey: 'invoice#1',
      customerId: 'ada',
      amount: 200,
    });
    expect(await compensateOrder(p, 'o2')).toMatchObject({ creditReleased: 0, unbilled: 1 });
    expect(await p.balances.account('ada')).toMatchObject({ balance: 0, held: 0, available: 500 });
  });

  it('undoes nothing for an order that holds nothing', async () => {
    expect(await compensateOrder(ports(), 'o_none', 1)).toEqual({
      released: 0,
      voided: 0,
      cancelled: 0,
      restored: 0,
      sellerOrdersCancelled: 0,
      payoutsReversed: 0,
      revoked: 0,
      unbilled: 0,
      creditReleased: 0,
      budgetSpendReversed: 0,
      promotionsReleased: 0,
      invoicesVoided: 0,
      invoicesPaid: [],
      labelsNotVoided: 0,
    });
  });

  it('gives back the budget spend the order recorded, once', async () => {
    const p = ports();
    const window = { start: 0, end: null };
    await p.budgets.put({
      id: 'bud_1',
      companyId: 'ada',
      teamId: null,
      name: 'Office',
      amount: 500,
      period: 'one_time',
      anchor: 0,
      enforcement: 'strict',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    });
    await p.budgets.commit({
      orderId: 'o1',
      stepKey: 'budget#1',
      at: 1,
      lines: [{ budgetId: 'bud_1', amount: 100, window }],
    });
    const spent = async () =>
      (await p.budgets.spentIn([{ budgetId: 'bud_1', windowStart: 0 }])).get('bud_1@0');
    expect(await spent()).toBe(100);

    expect(await compensateOrder(p, 'o1', 2)).toMatchObject({ budgetSpendReversed: 1 });
    expect(await spent()).toBe(0);
    expect(await compensateOrder(p, 'o1', 3)).toMatchObject({ budgetSpendReversed: 0 });
    expect(await spent()).toBe(0);
  });

  it('gives back the promotion redemptions the order held, once', async () => {
    const p = ports();
    const promotion = { id: 'promo_1', maxRedemptions: 1 };
    expect(
      await p.pricing.redeem({
        promotion,
        orderId: 'o1',
        customerId: 'ada',
        amount: 5,
        stepKey: 'discount#1',
      }),
    ).toBe(true);
    // The cap is spent: another order can't redeem until this one lets go.
    expect(
      await p.pricing.redeem({
        promotion,
        orderId: 'o2',
        customerId: 'ada',
        amount: 5,
        stepKey: 'discount#1',
      }),
    ).toBe(false);

    expect(await compensateOrder(p, 'o1', 1)).toMatchObject({ promotionsReleased: 1 });
    expect(await compensateOrder(p, 'o1', 2)).toMatchObject({ promotionsReleased: 0 });
    expect(
      await p.pricing.redeem({
        promotion,
        orderId: 'o2',
        customerId: 'ada',
        amount: 5,
        stepKey: 'discount#1',
      }),
    ).toBe(true);
  });
});
