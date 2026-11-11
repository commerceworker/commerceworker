/**
 * The behaviour every `BudgetStore` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). Ids start `bd_`; the D1 run deletes those rows before each case.
 */
import { type Budget, spendKey } from '@commerceworker/core';
import type { BudgetScope, BudgetStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const ALL = { all: true } as const;
const W1 = { start: 1_000, end: 2_000 };
const W2 = { start: 2_000, end: 3_000 };

const budget = (id: string, over: Partial<Budget> = {}): Budget => ({
  id,
  companyId: 'bd_co_a',
  teamId: null,
  name: id,
  amount: 100,
  period: 'monthly',
  anchor: 0,
  enforcement: 'advisory',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

async function seed(s: BudgetStore, ...bs: Budget[]) {
  for (const b of bs) expect(await s.put(b)).toBe(true);
}

const spent = async (s: BudgetStore, id: string, start = W1.start) =>
  (await s.spentIn([{ budgetId: id, windowStart: start }])).get(spendKey(id, start));

export function describeBudgetStoreContract(name: string, make: () => Promise<BudgetStore>) {
  describe(`${name}: the budget store contract`, () => {
    it('keeps a budget by id, changes only its name, amount and enforcement, and refuses another company’s id', async () => {
      const s = await make();
      await seed(s, budget('bd_1', { teamId: 'bd_t', name: 'Travel', amount: 500 }));
      expect(await s.budget(ALL, 'bd_1')).toMatchObject({ name: 'Travel', amount: 500 });
      expect(
        await s.put(
          budget('bd_1', {
            name: 'Trips',
            amount: 900,
            enforcement: 'strict',
            // None of these changes: the ledger counts in them.
            teamId: null,
            period: 'weekly',
            anchor: 77,
            updatedAt: 5,
          }),
        ),
      ).toBe(true);
      expect(await s.budget(ALL, 'bd_1')).toEqual(
        budget('bd_1', {
          teamId: 'bd_t',
          name: 'Trips',
          amount: 900,
          enforcement: 'strict',
          updatedAt: 5,
        }),
      );
      // Another company can't take it over by writing its id.
      expect(await s.put(budget('bd_1', { companyId: 'bd_co_b', name: 'Mine' }))).toBe(false);
      expect((await s.budget(ALL, 'bd_1'))?.name).toBe('Trips');
    });

    it('moves a status only from the one read, and of two racing moves one wins', async () => {
      const s = await make();
      await seed(s, budget('bd_1'));
      expect(await s.transition(ALL, 'bd_1', 'paused', 'active', 2)).toBe(false);
      const results = await Promise.all([
        s.transition(ALL, 'bd_1', 'active', 'paused', 2),
        s.transition(ALL, 'bd_1', 'active', 'archived', 2),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await s.transition({ companyId: 'bd_co_b' }, 'bd_1', 'paused', 'active', 3)).toBe(
        false,
      );
      expect(await s.transition({ companyId: 'bd_co_a' }, 'bd_1', 'paused', 'active', 3)).toBe(
        results[0] === true,
      );
    });

    it('bounds every read by its scope', async () => {
      const s = await make();
      await seed(s, budget('bd_a1'), budget('bd_b1', { companyId: 'bd_co_b' }));
      const a: BudgetScope = { companyId: 'bd_co_a' };
      expect(await s.budget(a, 'bd_b1')).toBeUndefined();
      expect((await s.budgets(a, { limit: 10 })).rows.map((b) => b.id)).toEqual(['bd_a1']);
      // Naming another company doesn't widen a scope.
      expect(await s.budgets(a, { companyId: 'bd_co_b', limit: 10 })).toEqual({
        rows: [],
        total: 0,
        next: null,
      });
      expect(await s.applicable(a, 'bd_co_b', [])).toEqual([]);
      expect((await s.budgets(ALL, { companyId: 'bd_co_b', limit: 10 })).rows).toHaveLength(1);
      expect(await s.transition(a, 'bd_b1', 'active', 'paused', 2)).toBe(false);
      await seed(s, budget('bd_b2', { companyId: 'bd_co_b' }));
      expect(
        await s.commit({
          orderId: 'o',
          stepKey: 's',
          at: 1,
          lines: [{ budgetId: 'bd_b1', amount: 5, window: W1 }],
        }),
      ).toBe(true);
      expect(await s.entries(a, { budgetId: 'bd_b1', limit: 10 })).toEqual({
        rows: [],
        total: 0,
        next: null,
      });
      expect(
        (await s.entries({ companyId: 'bd_co_b' }, { budgetId: 'bd_b1', limit: 10 })).total,
      ).toBe(1);
    });

    it('pages by name with a total, and filters by status and team', async () => {
      const s = await make();
      await seed(
        s,
        budget('bd_1', { name: 'Beta' }),
        budget('bd_2', { name: 'Alpha', teamId: 'bd_t' }),
        budget('bd_3', { name: 'Gamma', status: 'paused' }),
        budget('bd_4', { name: 'Alpha' }),
      );
      const first = await s.budgets(ALL, { companyId: 'bd_co_a', limit: 2 });
      expect(first.rows.map((b) => b.id)).toEqual(['bd_2', 'bd_4']);
      expect(first.total).toBe(4);
      expect(first.next).not.toBeNull();
      const rest = await s.budgets(ALL, { companyId: 'bd_co_a', limit: 2, after: first.next! });
      expect(rest.rows.map((b) => b.id)).toEqual(['bd_1', 'bd_3']);
      expect(rest.next).toBeNull();
      expect(
        (await s.budgets(ALL, { companyId: 'bd_co_a', status: 'paused', limit: 5 })).rows.map(
          (b) => b.id,
        ),
      ).toEqual(['bd_3']);
      expect((await s.budgets(ALL, { companyId: 'bd_co_a', teamId: 'bd_t', limit: 5 })).total).toBe(
        1,
      );
    });

    it('finds the active budgets an order is held to: the company’s and its team’s, no one else’s', async () => {
      const s = await make();
      await seed(
        s,
        budget('bd_whole', { name: 'a' }),
        budget('bd_team', { name: 'b', teamId: 'bd_t2' }),
        budget('bd_parent', { name: 'c', teamId: 'bd_t1' }),
        budget('bd_other_team', { name: 'd', teamId: 'bd_t9' }),
        budget('bd_paused', { name: 'e', status: 'paused' }),
        budget('bd_archived', { name: 'f', status: 'archived' }),
        budget('bd_elsewhere', { companyId: 'bd_co_b' }),
      );
      const ids = async (teams: string[]) =>
        (await s.applicable(ALL, 'bd_co_a', teams)).map((b) => b.id);
      expect(await ids(['bd_t1', 'bd_t2'])).toEqual(['bd_whole', 'bd_team', 'bd_parent']);
      expect(await ids([])).toEqual(['bd_whole']);
    });

    it('sums spend per window from the ledger, and a window with none reads zero', async () => {
      const s = await make();
      await seed(s, budget('bd_1'), budget('bd_2'));
      const at = 10;
      await s.commit({
        orderId: 'bd_o1',
        stepKey: 'chk#1',
        at,
        lines: [{ budgetId: 'bd_1', amount: 30.1, window: W1 }],
      });
      await s.commit({
        orderId: 'bd_o2',
        stepKey: 'chk#1',
        at,
        lines: [
          { budgetId: 'bd_1', amount: 20.2, window: W1 },
          { budgetId: 'bd_2', amount: 5, window: W1 },
        ],
      });
      await s.commit({
        orderId: 'bd_o3',
        stepKey: 'chk#1',
        at,
        lines: [{ budgetId: 'bd_1', amount: 7, window: W2 }],
      });
      const sums = await s.spentIn([
        { budgetId: 'bd_1', windowStart: W1.start },
        { budgetId: 'bd_1', windowStart: W2.start },
        { budgetId: 'bd_2', windowStart: W1.start },
        { budgetId: 'bd_2', windowStart: W2.start },
      ]);
      expect(Object.fromEntries(sums)).toEqual({
        [spendKey('bd_1', W1.start)]: 50.3,
        [spendKey('bd_1', W2.start)]: 7,
        [spendKey('bd_2', W1.start)]: 5,
        [spendKey('bd_2', W2.start)]: 0,
      });
      expect(await s.spentIn([])).toEqual(new Map());
      // A retrying step asks without the rows it wrote itself.
      expect(
        (
          await s.spentIn([{ budgetId: 'bd_1', windowStart: W1.start }], ['bsp_bd_o1_chk_1_bd_1'])
        ).get(spendKey('bd_1', W1.start)),
      ).toBe(20.2);
    });

    it('commits once per order, step and budget, however many times a step retries', async () => {
      const s = await make();
      await seed(s, budget('bd_1'));
      const c = {
        orderId: 'bd_o1',
        stepKey: 'chk#1',
        at: 10,
        lines: [{ budgetId: 'bd_1', amount: 40, window: W1 }],
      };
      expect(await s.commit(c)).toBe(true);
      expect(await s.commit(c)).toBe(true);
      expect(await s.commit({ ...c, at: 99 })).toBe(true);
      expect(await spent(s, 'bd_1')).toBe(40);
      // Another step of the same order is another commit.
      expect(await s.commit({ ...c, stepKey: 'chk#2' })).toBe(true);
      expect(await spent(s, 'bd_1')).toBe(80);
      const ledger = await s.entries(ALL, { budgetId: 'bd_1', limit: 10 });
      expect(ledger.total).toBe(2);
      // The same instant orders by id, newest first.
      expect(ledger.rows.map((e) => e.id)).toEqual([
        'bsp_bd_o1_chk_2_bd_1',
        'bsp_bd_o1_chk_1_bd_1',
      ]);
      expect(ledger.rows[1]).toMatchObject({
        id: 'bsp_bd_o1_chk_1_bd_1',
        orderId: 'bd_o1',
        amount: 40,
        kind: 'commit',
        windowStart: W1.start,
        reversed: false,
      });
    });

    it('lets an advisory budget go over, and refuses a strict one that would go below zero', async () => {
      const s = await make();
      await seed(
        s,
        budget('bd_adv', { amount: 50 }),
        budget('bd_strict', { amount: 50, enforcement: 'strict' }),
      );
      const line = (id: string, amount: number) => ({ budgetId: id, amount, window: W1 });
      expect(
        await s.commit({ orderId: 'bd_o1', stepKey: 's', at: 1, lines: [line('bd_adv', 80)] }),
      ).toBe(true);
      expect(await spent(s, 'bd_adv')).toBe(80);
      // Exactly what's left fits; a cent more doesn't.
      expect(
        await s.commit({ orderId: 'bd_o2', stepKey: 's', at: 1, lines: [line('bd_strict', 50)] }),
      ).toBe(true);
      expect(
        await s.commit({ orderId: 'bd_o3', stepKey: 's', at: 1, lines: [line('bd_strict', 0.01)] }),
      ).toBe(false);
      expect(await spent(s, 'bd_strict')).toBe(50);
      // A window with room is judged on its own.
      expect(
        await s.commit({
          orderId: 'bd_o4',
          stepKey: 's',
          at: 1,
          lines: [{ budgetId: 'bd_strict', amount: 50, window: W2 }],
        }),
      ).toBe(true);
    });

    it('writes all of an order’s lines or none: a strict refusal leaves the advisory ones unwritten', async () => {
      const s = await make();
      await seed(
        s,
        budget('bd_adv', { amount: 500 }),
        budget('bd_strict', { amount: 10, enforcement: 'strict' }),
      );
      const refused = await s.commit({
        orderId: 'bd_o1',
        stepKey: 's',
        at: 1,
        lines: [
          { budgetId: 'bd_adv', amount: 20, window: W1 },
          { budgetId: 'bd_strict', amount: 20, window: W1 },
        ],
      });
      expect(refused).toBe(false);
      expect(await spent(s, 'bd_adv')).toBe(0);
      expect(await spent(s, 'bd_strict')).toBe(0);
      // A budget that isn't there refuses too.
      expect(
        await s.commit({
          orderId: 'bd_o2',
          stepKey: 's',
          at: 1,
          lines: [{ budgetId: 'bd_nope', amount: 1, window: W1 }],
        }),
      ).toBe(false);
    });

    it('lets a strict budget raced by several orders take only what fits', async () => {
      const s = await make();
      await seed(s, budget('bd_1', { amount: 100, enforcement: 'strict' }));
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          s.commit({
            orderId: `bd_o${i}`,
            stepKey: 's',
            at: 1,
            lines: [{ budgetId: 'bd_1', amount: 30, window: W1 }],
          }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(3);
      expect(await spent(s, 'bd_1')).toBe(90);
    });

    it('reverses an order’s spend once, netting its window, and a retried commit adds nothing back', async () => {
      const s = await make();
      await seed(s, budget('bd_1'), budget('bd_2'));
      const c = {
        orderId: 'bd_o1',
        stepKey: 'chk#1',
        at: 10,
        lines: [
          { budgetId: 'bd_1', amount: 40, window: W1 },
          { budgetId: 'bd_2', amount: 15, window: W2 },
        ],
      };
      await s.commit(c);
      await s.commit({
        orderId: 'bd_o2',
        stepKey: 'chk#1',
        at: 10,
        lines: [{ budgetId: 'bd_1', amount: 5, window: W1 }],
      });
      expect(await s.reverse('bd_o1', 20)).toBe(2);
      expect(await s.reverse('bd_o1', 30)).toBe(0);
      expect(await s.reverse('bd_missing', 30)).toBe(0);
      expect(await spent(s, 'bd_1')).toBe(5);
      expect(await spent(s, 'bd_2', W2.start)).toBe(0);
      // A step retried after the rollback finds its rows and adds none.
      expect(await s.commit(c)).toBe(true);
      expect(await spent(s, 'bd_1')).toBe(5);
      const ledger = await s.entries(ALL, { budgetId: 'bd_1', limit: 10 });
      expect(ledger.rows.map((e) => [e.orderId, e.reversed])).toEqual([
        ['bd_o2', false],
        ['bd_o1', true],
      ]);
    });

    it('frees a reversed order’s room for a strict budget', async () => {
      const s = await make();
      await seed(s, budget('bd_1', { amount: 100, enforcement: 'strict' }));
      const line = (amount: number) => [{ budgetId: 'bd_1', amount, window: W1 }];
      await s.commit({ orderId: 'bd_o1', stepKey: 's', at: 1, lines: line(100) });
      expect(await s.commit({ orderId: 'bd_o2', stepKey: 's', at: 1, lines: line(60) })).toBe(
        false,
      );
      await s.reverse('bd_o1', 2);
      expect(await s.commit({ orderId: 'bd_o2', stepKey: 's', at: 3, lines: line(60) })).toBe(true);
    });

    it('pages a budget’s ledger newest first with its total', async () => {
      const s = await make();
      await seed(s, budget('bd_1'));
      for (const [i, at] of [10, 30, 20, 30].entries())
        await s.commit({
          orderId: `bd_o${i}`,
          stepKey: 's',
          at,
          lines: [{ budgetId: 'bd_1', amount: 1 + i, window: W1 }],
        });
      const first = await s.entries(ALL, { budgetId: 'bd_1', limit: 3 });
      expect(first.total).toBe(4);
      expect(first.rows.map((e) => e.at)).toEqual([30, 30, 20]);
      const rest = await s.entries(ALL, { budgetId: 'bd_1', limit: 3, after: first.next! });
      expect(rest.rows.map((e) => [e.at, e.orderId])).toEqual([[10, 'bd_o0']]);
      expect(rest.next).toBeNull();
      // The two at 30 come in a stable order, so no page repeats or skips one.
      expect(first.rows.map((e) => e.orderId)).toEqual(['bd_o3', 'bd_o1', 'bd_o2']);
    });
  });
}
