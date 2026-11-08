/**
 * The behaviour every `BalanceStore` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). Each case seeds a fresh store; order and customer ids are distinctive so a
 * backend holding other rows can't satisfy an assertion by accident.
 */
import type { BalanceStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { BalanceFixture } from './balance-store';

export const BALANCE_FIXTURE: BalanceFixture = {
  customers: [
    { id: 'bc_northwind', balance: 1_000 },
    { id: 'bc_fabrikam', balance: 0 },
  ],
};

export function describeBalanceStoreContract(
  name: string,
  make: (fixture: BalanceFixture) => Promise<BalanceStore>,
) {
  describe(`${name}: the balance store contract`, () => {
    const fresh = () => make(BALANCE_FIXTURE);
    const charge = (s: BalanceStore, orderId: string, amount = 250, stepKey = 'invoice#1') =>
      s.charge({ orderId, stepKey, customerId: 'bc_northwind', amount });

    it('reads balances, and nothing for an unknown customer', async () => {
      const s = await fresh();
      expect(await s.balance('bc_northwind')).toBe(1_000);
      expect(await s.balance('bc_fabrikam')).toBe(0);
      expect(await s.balance('bc_nobody')).toBeUndefined();
    });

    it('charges once per order and step, keyed by both', async () => {
      const s = await fresh();
      expect(await charge(s, 'bc_order:1')).toBe('bal_bc_order_1_invoice_1');
      await charge(s, 'bc_order:1');
      expect(await s.balance('bc_northwind')).toBe(1_250);
      await charge(s, 'bc_order:1', 250, 'invoice#2');
      expect(await s.balance('bc_northwind')).toBe(1_500);
      expect((await s.entries('bc_order:1')).map((e) => [e.id, e.amount, e.applied])).toEqual([
        ['bal_bc_order_1_invoice_1', 250, true],
        ['bal_bc_order_1_invoice_2', 250, true],
      ]);
    });

    it('settles a paid charge once, after which a rollback reverses nothing', async () => {
      const s = await fresh();
      const id = await charge(s, 'bc_paid');
      expect(await s.settle(id)).toBe(true);
      expect(await s.settle(id)).toBe(false);
      expect(await s.reverse('bc_paid')).toBe(0);
      expect(await s.balance('bc_northwind')).toBe(1_000);
      expect((await s.entries('bc_paid')).map((e) => [e.id.split('_')[0], e.amount])).toEqual([
        ['bal', 250],
        ['set', -250],
      ]);
    });

    it('reverses every open charge once, after which a payment settles nothing', async () => {
      const s = await fresh();
      const first = await charge(s, 'bc_rolled', 100, 'invoice#1');
      await charge(s, 'bc_rolled', 50, 'invoice#2');
      expect(await s.balance('bc_northwind')).toBe(1_150);
      expect(await s.reverse('bc_rolled')).toBe(2);
      expect(await s.reverse('bc_rolled')).toBe(0);
      expect(await s.settle(first)).toBe(false);
      expect(await s.balance('bc_northwind')).toBe(1_000);
    });

    it('reverses only the charges a payment left open', async () => {
      const s = await fresh();
      const paid = await charge(s, 'bc_mixed', 100, 'invoice#1');
      await charge(s, 'bc_mixed', 50, 'invoice#2');
      await s.settle(paid);
      expect(await s.reverse('bc_mixed')).toBe(1);
      expect(await s.balance('bc_northwind')).toBe(1_000);
    });

    it('settles nothing for an unknown entry or a settlement row', async () => {
      const s = await fresh();
      expect(await s.settle('bal_bc_none')).toBe(false);
      const id = await charge(s, 'bc_offset');
      await s.settle(id);
      expect(await s.settle(`set_${id}`)).toBe(false);
      expect(await s.balance('bc_northwind')).toBe(1_000);
    });

    it('reverses nothing for an order with no charges', async () => {
      const s = await fresh();
      expect(await s.reverse('bc_empty')).toBe(0);
      expect(await s.entries('bc_empty')).toEqual([]);
    });
  });
}
