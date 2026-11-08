/**
 * The balances port (`BalanceStore`, @commerceworker/ports/commerce) on D1. Moved here from the
 * engine's connectors and billing. Every change is a `balance_entries` row and the balance update
 * it makes, in one batch (one D1 transaction), each guarded so it applies at most once. A charge
 * comes off the balance by its `set_` row when its invoice is paid or its `rev_` row when the order
 * is rolled back, whichever comes first. The contract in @commerceworker/test-kit/commerce holds
 * this and the in-memory store to the same behaviour.
 */
import type { Clock } from '@commerceworker/ports';
import { type BalanceStore, balanceEntryId } from '@commerceworker/ports/commerce';
import { and, eq, sql } from 'drizzle-orm';
import { createDb } from './index';
import { balanceEntries, customers } from './schema';

const settleId = (entryId: string) => `set_${entryId}`;
const reverseId = (entryId: string) => `rev_${entryId}`;

type Entry = typeof balanceEntries.$inferSelect;

export function d1BalanceStore(d1: D1Database, clock: Clock): BalanceStore {
  const d = createDb(d1);
  const now = () => clock.now().getTime();

  /** True while the entry has been neither settled nor reversed: either takes it off the balance. */
  const unsettled = (entryId: string) =>
    sql`not exists (select 1 from ${balanceEntries} other where other.id in (${settleId(entryId)}, ${reverseId(entryId)}) and other.applied = 1)`;

  /**
   * Takes a charge back off the balance once, by the offset row `id`: insert the row while the
   * charge is still open, move the balance while the row is pending, mark it applied. The mark
   * returns the row only when this batch applied it.
   */
  function offset(entry: Entry, id: string, at: number) {
    const pending = and(eq(balanceEntries.id, id), eq(balanceEntries.applied, false));
    return [
      d
        .insert(balanceEntries)
        .select(
          d
            .select({
              id: sql`${id}`.as('id'),
              orderId: balanceEntries.orderId,
              customerId: balanceEntries.customerId,
              amount: sql`-${balanceEntries.amount}`.as('amount'),
              applied: sql`0`.as('applied'),
              createdAt: sql`${at}`.as('created_at'),
            })
            .from(balanceEntries)
            .where(
              and(
                eq(balanceEntries.id, entry.id),
                eq(balanceEntries.applied, true),
                unsettled(entry.id),
              ),
            ),
        )
        .onConflictDoNothing(),
      d
        .update(customers)
        .set({ balance: sql`${customers.balance} - ${entry.amount}` })
        .where(
          and(
            eq(customers.id, entry.customerId),
            sql`exists (select 1 from ${balanceEntries} where ${pending})`,
          ),
        ),
      d.update(balanceEntries).set({ applied: true }).where(pending).returning(),
    ] as const;
  }

  return {
    async charge(e) {
      const id = balanceEntryId(e.orderId, e.stepKey);
      const pending = and(eq(balanceEntries.id, id), eq(balanceEntries.applied, false));
      await d.batch([
        d
          .insert(balanceEntries)
          .values({
            id,
            orderId: e.orderId,
            customerId: e.customerId,
            amount: e.amount,
            createdAt: now(),
          })
          .onConflictDoNothing(),
        d
          .update(customers)
          .set({ balance: sql`${customers.balance} + ${e.amount}` })
          .where(
            and(
              eq(customers.id, e.customerId),
              sql`exists (select 1 from ${balanceEntries} where ${pending})`,
            ),
          ),
        d.update(balanceEntries).set({ applied: true }).where(eq(balanceEntries.id, id)),
      ]);
      return id;
    },

    async settle(entryId) {
      const entry = await d
        .select()
        .from(balanceEntries)
        .where(eq(balanceEntries.id, entryId))
        .get();
      if (!entry || entry.amount <= 0) return false;
      const [, , mark] = await d.batch(offset(entry, settleId(entry.id), now()));
      return mark.length > 0;
    },

    async reverse(orderId) {
      const entries = await d
        .select()
        .from(balanceEntries)
        .where(
          and(
            eq(balanceEntries.orderId, orderId),
            eq(balanceEntries.applied, true),
            sql`${balanceEntries.amount} > 0`,
          ),
        );
      if (!entries.length) return 0;
      // One batch for every entry; each entry's three statements keep their own guards.
      const at = now();
      const [head, ...rest] = entries.flatMap((e) => offset(e, reverseId(e.id), at));
      const results = await d.batch([head!, ...rest]);
      // Every third result is an entry's mark, which returns the row only when it reversed it.
      return results.filter((r, i) => i % 3 === 2 && (r as unknown[]).length).length;
    },

    async balance(customerId) {
      const row = await d
        .select({ balance: customers.balance })
        .from(customers)
        .where(eq(customers.id, customerId))
        .get();
      return row?.balance;
    },

    async entries(orderId) {
      return d
        .select({
          id: balanceEntries.id,
          orderId: balanceEntries.orderId,
          customerId: balanceEntries.customerId,
          amount: balanceEntries.amount,
          applied: balanceEntries.applied,
        })
        .from(balanceEntries)
        .where(eq(balanceEntries.orderId, orderId))
        .orderBy(balanceEntries.id);
    },
  };
}
