/**
 * The behaviour every `BalanceStore` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). Each case seeds a fresh store; order and customer ids are distinctive so a
 * backend holding other rows can't satisfy an assertion by accident.
 */
import type { BalanceStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../fakes';
import type { BalanceFixture } from './balance-store';

export const BALANCE_FIXTURE: BalanceFixture = {
  customers: [
    { id: 'bc_northwind', balance: 1_000, creditLimit: 2_000 },
    { id: 'bc_fabrikam', balance: 0, creditLimit: 500 },
  ],
};

const HOUR = 3_600_000;

const BASE = {
  orderId: 'bc_base',
  stepKey: 'credit#1',
  customerId: 'bc_northwind',
  amount: 1,
  expiresAt: Date.parse('2026-11-30T00:00:00Z'),
};

export function describeBalanceStoreContract(
  name: string,
  make: (fixture: BalanceFixture, clock: FixedClock) => Promise<BalanceStore>,
) {
  describe(`${name}: the balance store contract`, () => {
    const fresh = () => make(BALANCE_FIXTURE, new FixedClock(new Date('2026-11-01T00:00:00Z')));
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

    describe('credit', () => {
      const clockAndStore = async () => {
        const clock = new FixedClock(new Date('2026-11-01T00:00:00Z'));
        return { clock, s: await make(BALANCE_FIXTURE, clock) };
      };
      const take = (
        s: BalanceStore,
        orderId: string,
        amount: number,
        expiresAt = Date.parse('2026-11-30T00:00:00Z'),
        stepKey = 'credit#1',
      ) => s.hold({ orderId, stepKey, customerId: 'bc_northwind', amount, expiresAt });

      it('holds what the limit less the balance covers, and refuses the rest', async () => {
        const s = await fresh();
        // 2,000 limit, 1,000 owed.
        expect(await s.account('bc_northwind')).toEqual({
          limit: 2_000,
          balance: 1_000,
          held: 0,
          available: 1_000,
        });
        expect(await take(s, 'bc_h1', 600)).toEqual({ held: true, available: 400 });
        expect(await take(s, 'bc_h2', 400)).toEqual({ held: true, available: 0 });
        expect(await take(s, 'bc_h3', 0.01)).toEqual({ held: false, available: 0 });
        expect(await s.account('bc_northwind')).toMatchObject({ held: 1_000, available: 0 });
        expect(await s.hold({ ...BASE, customerId: 'bc_nobody' })).toEqual({
          held: false,
          available: 0,
        });
      });

      it('never lets two concurrent holds together exceed the limit', async () => {
        const s = await fresh();
        // 1,000 available: each wants 400, so two fit.
        const results = await Promise.all(
          ['a', 'b', 'c', 'd', 'e'].map((o) => take(s, `bc_race_${o}`, 400)),
        );
        expect(results.filter((r) => r.held)).toHaveLength(2);
        const account = await s.account('bc_northwind');
        expect(account).toMatchObject({ held: 800, available: 200 });
      });

      it('finds a retried step’s own hold, which holds once', async () => {
        const s = await fresh();
        expect(await take(s, 'bc_retry', 700)).toEqual({ held: true, available: 300 });
        expect(await take(s, 'bc_retry', 700)).toEqual({ held: true, available: 300 });
        // The same order's next credit check is a different step, which holds again.
        expect(await take(s, 'bc_retry', 100, undefined, 'credit#2')).toEqual({
          held: true,
          available: 200,
        });
        expect((await s.account('bc_northwind'))?.held).toBe(800);
      });

      it('converts an order’s hold into its charge exactly once', async () => {
        const s = await fresh();
        await take(s, 'bc_conv', 300);
        expect((await s.account('bc_northwind'))?.available).toBe(700);
        await charge(s, 'bc_conv', 300);
        // Charged: owed now, no longer held, so the same credit is claimed once, not twice.
        expect(await s.account('bc_northwind')).toMatchObject({
          balance: 1_300,
          held: 0,
          available: 700,
        });
        await charge(s, 'bc_conv', 300);
        expect(await s.account('bc_northwind')).toMatchObject({ balance: 1_300, held: 0 });
        // Nothing is left to release, and a retried hold step still reads as held.
        expect(await s.releaseHolds('bc_conv')).toBe(0);
        expect(await take(s, 'bc_conv', 300)).toEqual({ held: true, available: 700 });
      });

      it('releases an order’s holds once, and leaves other orders’ alone', async () => {
        const s = await fresh();
        await take(s, 'bc_rel', 300);
        await take(s, 'bc_rel', 200, undefined, 'credit#2');
        await take(s, 'bc_other', 100);
        expect(await s.releaseHolds('bc_rel')).toBe(2);
        expect(await s.releaseHolds('bc_rel')).toBe(0);
        expect(await s.releaseHolds('bc_none')).toBe(0);
        expect(await s.account('bc_northwind')).toMatchObject({ held: 100, available: 900 });
        // A released hold is not this step's any more: a late retry doesn't re-take it.
        expect((await take(s, 'bc_rel', 300)).held).toBe(false);
      });

      it('stops counting a hold once it expires', async () => {
        const { clock, s } = await clockAndStore();
        const expires = clock.now().getTime() + HOUR;
        await take(s, 'bc_exp', 900, expires);
        expect((await take(s, 'bc_exp2', 200)).held).toBe(false);
        clock.advance(HOUR + 1);
        expect(await s.account('bc_northwind')).toMatchObject({ held: 0, available: 1_000 });
        expect((await take(s, 'bc_exp2', 200)).held).toBe(true);
        expect((await s.account('bc_northwind'))?.held).toBe(200);
      });

      it('records an adjustment once per key, with its reason', async () => {
        const s = await fresh();
        const adj = (key: string, amount: number, customerId = 'bc_northwind') =>
          s.adjust({ key, customerId, amount, reason: 'Credit memo 41', by: 'ann@example.com' });
        expect(await adj('bc_adj1', -250)).toBe('adj_bc_adj1');
        expect(await adj('bc_adj1', -250)).toBe('adj_bc_adj1');
        expect(await s.balance('bc_northwind')).toBe(750);
        expect(await adj('bc_adj2', 50)).toBe('adj_bc_adj2');
        expect(await s.balance('bc_northwind')).toBe(800);
        expect(await adj('bc_adj3', 1, 'bc_nobody')).toBeUndefined();
        const { entries } = await s.ledger('bc_northwind', undefined, 10);
        expect(entries.map((e) => [e.kind, e.amount, e.note, e.reference, e.orderId])).toEqual(
          expect.arrayContaining([
            ['adjust', -250, 'Credit memo 41', 'ann@example.com', null],
            ['adjust', 50, 'Credit memo 41', 'ann@example.com', null],
          ]),
        );
        // A rollback of an order reverses its charges, never an adjustment.
        expect(await s.reverse('')).toBe(0);
        expect(await s.balance('bc_northwind')).toBe(800);
      });

      it('sets a limit, for a customer that exists', async () => {
        const s = await fresh();
        expect(await s.setLimit('bc_northwind', 1_500)).toBe(true);
        expect(await s.account('bc_northwind')).toMatchObject({ limit: 1_500, available: 500 });
        expect(await s.setLimit('bc_nobody', 1)).toBe(false);
        expect(await s.account('bc_nobody')).toBeUndefined();
      });

      it('pages the ledger newest first, each entry with the balance it left', async () => {
        const { clock, s } = await clockAndStore();
        const step = () => clock.advance(1_000);
        await charge(s, 'bc_led1', 100); // 1,100
        step();
        const paid = await charge(s, 'bc_led2', 50, 'invoice#1'); // 1,150
        step();
        await s.settle(paid); // 1,100
        step();
        await s.adjust({
          key: 'bc_led',
          customerId: 'bc_northwind',
          amount: -300,
          reason: 'memo',
          by: 'a',
        }); // 800
        step();
        await charge(s, 'bc_led3', 25); // 825
        await s.hold({ ...BASE, orderId: 'bc_led4', amount: 10 }); // holds are not entries
        const first = await s.ledger('bc_northwind', undefined, 2);
        expect(first.entries.map((e) => [e.kind, e.amount, e.balanceAfter])).toEqual([
          ['charge', 25, 825],
          ['adjust', -300, 800],
        ]);
        expect(first.next).not.toBeNull();
        const second = await s.ledger('bc_northwind', first.next!, 2);
        expect(second.entries.map((e) => [e.kind, e.amount, e.balanceAfter])).toEqual([
          ['settle', -50, 1_100],
          ['charge', 50, 1_150],
        ]);
        const third = await s.ledger('bc_northwind', second.next!, 2);
        expect(third.entries.map((e) => [e.kind, e.amount, e.balanceAfter])).toEqual([
          ['charge', 100, 1_100],
        ]);
        expect(third.next).toBeNull();
        expect(second.entries[0]).toMatchObject({ orderId: 'bc_led2', reference: paid });
        expect(await s.ledger('bc_fabrikam', undefined, 5)).toEqual({ entries: [], next: null });
      });
    });
  });
}
