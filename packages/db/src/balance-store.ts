/**
 * The balances port (`BalanceStore`, @commerceworker/ports/commerce) on D1. Moved here from the
 * engine's connectors and billing. Every change is a `balance_entries` row and the balance update
 * it makes, in one batch (one D1 transaction), each guarded so it applies at most once. A charge
 * comes off the balance by its `set_` row when its invoice is paid or its `rev_` row when the order
 * is rolled back, whichever comes first. Credit holds are `credit_holds` rows: taking one is a
 * single insert guarded by the limit (limit less balance less the open holds), so the check and the
 * hold can't be interleaved, and charging converts the order's holds in the charge's own batch.
 * What a customer holds is summed from its open rows, never kept as a counter, so a hold that
 * expired just stops counting. The contract in @commerceworker/test-kit/commerce holds this and
 * the in-memory store to the same behaviour.
 */
import { creditAdjustmentId, creditAvailable, creditHoldId, money } from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import {
  type BalanceStore,
  balanceEntryId,
  type LedgerEntry,
} from '@commerceworker/ports/commerce';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { createDb } from './index';
import { balanceEntries, creditHolds, customers } from './schema';

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
  function offset(entry: Entry, id: string, kind: 'settle' | 'reverse', at: number) {
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
              kind: sql`${kind}`.as('kind'),
              reference: sql`${entry.id}`.as('reference'),
              note: sql`null`.as('note'),
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

  /** What the customer's open holds claim at `at`: the `held` rows not past their expiry. */
  const openHeld = (at: number) =>
    sql`(select coalesce(sum(${creditHolds.amount}), 0) from ${creditHolds} where ${creditHolds.customerId} = ${customers.id} and ${creditHolds.status} = 'held' and ${creditHolds.expiresAt} > ${at})`;

  const accountOf = (customerId: string, at: number) =>
    d
      .select({
        limit: customers.creditLimit,
        balance: customers.balance,
        held: sql<number>`${openHeld(at)}`,
      })
      .from(customers)
      .where(eq(customers.id, customerId));

  const toAccount = (r: { limit: number; balance: number; held: number }) => ({
    limit: r.limit,
    balance: r.balance,
    held: money(r.held),
    available: creditAvailable({ creditLimit: r.limit, balance: r.balance, held: r.held }),
  });

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
        // The charge now stands for what the order held, in the batch that applies it: a retry,
        // whose charge is already applied, finds nothing pending and converts nothing.
        d
          .update(creditHolds)
          .set({ status: 'charged', resolvedAt: now() })
          .where(
            and(
              eq(creditHolds.orderId, e.orderId),
              eq(creditHolds.customerId, e.customerId),
              eq(creditHolds.status, 'held'),
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
      if (entry?.kind !== 'charge') return false;
      const [, , mark] = await d.batch(offset(entry, settleId(entry.id), 'settle', now()));
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
            eq(balanceEntries.kind, 'charge'),
          ),
        );
      if (!entries.length) return 0;
      // One batch for every entry; each entry's three statements keep their own guards.
      const at = now();
      const [head, ...rest] = entries.flatMap((e) => offset(e, reverseId(e.id), 'reverse', at));
      const results = await d.batch([head!, ...rest]);
      // Every third result is an entry's mark, which returns the row only when it reversed it.
      return results.filter((r, i) => i % 3 === 2 && (r as unknown[]).length).length;
    },

    async hold(h) {
      const id = creditHoldId(h.orderId, h.stepKey);
      const at = now();
      await d.batch([
        // First, so what expired stops counting as `expired` rather than as a hold nobody ended.
        d
          .update(creditHolds)
          .set({ status: 'expired', resolvedAt: at })
          .where(
            and(
              eq(creditHolds.customerId, h.customerId),
              eq(creditHolds.status, 'held'),
              lte(creditHolds.expiresAt, at),
            ),
          ),
        // The check and the hold in one statement: a row exists only if the limit covers it, and a
        // batch is one transaction on the one writer, so nothing lands between the two.
        d
          .insert(creditHolds)
          .select(
            d
              .select({
                id: sql`${id}`.as('id'),
                orderId: sql`${h.orderId}`.as('order_id'),
                customerId: customers.id,
                amount: sql`${h.amount}`.as('amount'),
                status: sql`'held'`.as('status'),
                expiresAt: sql`${h.expiresAt}`.as('expires_at'),
                createdAt: sql`${at}`.as('created_at'),
                resolvedAt: sql`null`.as('resolved_at'),
              })
              .from(customers)
              .where(
                and(
                  eq(customers.id, h.customerId),
                  sql`round(${customers.creditLimit} - ${customers.balance} - ${openHeld(at)}, 2) >= round(${h.amount}, 2)`,
                ),
              ),
          )
          .onConflictDoNothing(),
      ]);
      const [row, account] = await d.batch([
        d.select({ status: creditHolds.status }).from(creditHolds).where(eq(creditHolds.id, id)),
        accountOf(h.customerId, at),
      ]);
      // A hold that is still held, or that its invoice already charged, is this step's own: a retry.
      const held = row[0]?.status === 'held' || row[0]?.status === 'charged';
      return { held, available: account[0] ? toAccount(account[0]).available : 0 };
    },

    async releaseHolds(orderId) {
      const released = await d
        .update(creditHolds)
        .set({ status: 'released', resolvedAt: now() })
        .where(and(eq(creditHolds.orderId, orderId), eq(creditHolds.status, 'held')))
        .returning({ id: creditHolds.id });
      return released.length;
    },

    async adjust(a) {
      const id = creditAdjustmentId(a.key);
      const pending = and(eq(balanceEntries.id, id), eq(balanceEntries.applied, false));
      await d.batch([
        d
          .insert(balanceEntries)
          .select(
            d
              .select({
                id: sql`${id}`.as('id'),
                orderId: sql`''`.as('order_id'),
                customerId: customers.id,
                amount: sql`${a.amount}`.as('amount'),
                applied: sql`0`.as('applied'),
                kind: sql`'adjust'`.as('kind'),
                reference: sql`${a.by}`.as('reference'),
                note: sql`${a.reason}`.as('note'),
                createdAt: sql`${now()}`.as('created_at'),
              })
              .from(customers)
              .where(eq(customers.id, a.customerId)),
          )
          .onConflictDoNothing(),
        d
          .update(customers)
          .set({ balance: sql`${customers.balance} + ${a.amount}` })
          .where(
            and(
              eq(customers.id, a.customerId),
              sql`exists (select 1 from ${balanceEntries} where ${pending})`,
            ),
          ),
        d.update(balanceEntries).set({ applied: true }).where(pending),
      ]);
      const entry = await d
        .select({ id: balanceEntries.id })
        .from(balanceEntries)
        .where(and(eq(balanceEntries.id, id), eq(balanceEntries.applied, true)))
        .get();
      return entry?.id;
    },

    async setLimit(customerId, limit) {
      const rows = await d
        .update(customers)
        .set({ creditLimit: limit })
        .where(eq(customers.id, customerId))
        .returning({ id: customers.id });
      return rows.length > 0;
    },

    async account(customerId) {
      const row = await accountOf(customerId, now()).get();
      return row && toAccount(row);
    },

    async ledger(customerId, cursor, limit) {
      const mine = and(eq(balanceEntries.customerId, customerId), eq(balanceEntries.applied, true));
      // Entries at or after the cursor are newer than the page, so the page's first balance is the
      // customer's less what they moved.
      const newer = cursor
        ? sql`(${balanceEntries.createdAt}, ${balanceEntries.id}) >= (${cursor.at}, ${cursor.id})`
        : sql`0`;
      const older = cursor
        ? sql`(${balanceEntries.createdAt}, ${balanceEntries.id}) < (${cursor.at}, ${cursor.id})`
        : sql`1`;
      const [rows, moved, bal] = await d.batch([
        d
          .select()
          .from(balanceEntries)
          .where(and(mine, older))
          .orderBy(desc(balanceEntries.createdAt), desc(balanceEntries.id))
          .limit(limit + 1),
        d
          .select({ sum: sql<number>`coalesce(sum(${balanceEntries.amount}), 0)` })
          .from(balanceEntries)
          .where(and(mine, newer)),
        d
          .select({ balance: customers.balance })
          .from(customers)
          .where(eq(customers.id, customerId)),
      ]);
      let after = money((bal[0]?.balance ?? 0) - (moved[0]?.sum ?? 0));
      const page = rows.slice(0, limit);
      const entries: LedgerEntry[] = page.map((r) => {
        const entry: LedgerEntry = {
          id: r.id,
          at: r.createdAt,
          kind: r.kind as LedgerEntry['kind'],
          orderId: r.orderId || null,
          amount: r.amount,
          balanceAfter: after,
          reference: r.reference,
          note: r.note,
        };
        after = money(after - r.amount);
        return entry;
      });
      const last = page.at(-1);
      return {
        entries,
        next: rows.length > limit && last ? { at: last.createdAt, id: last.id } : null,
      };
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
