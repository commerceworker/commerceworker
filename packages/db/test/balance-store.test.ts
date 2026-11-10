import { env } from 'cloudflare:workers';
import {
  type BalanceFixture,
  describeBalanceStoreContract,
} from '@commerceworker/test-kit/commerce';
import { inArray, like } from 'drizzle-orm';
import { d1BalanceStore } from '../src/balance-store';
import { createDb } from '../src/index';
import { balanceEntries, creditHolds, customers } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

/** Resets the fixture's customers and every contract order's ledger, so each case starts the same. */
async function seed(f: BalanceFixture) {
  const db = createDb(DB);
  await db.delete(balanceEntries).where(like(balanceEntries.orderId, 'bc_%'));
  await db.delete(balanceEntries).where(
    inArray(
      balanceEntries.customerId,
      (f.customers ?? []).map((c) => c.id),
    ),
  );
  await db.delete(creditHolds).where(like(creditHolds.orderId, 'bc_%'));
  const ids = (f.customers ?? []).map((c) => c.id);
  if (ids.length) await db.delete(customers).where(inArray(customers.id, ids));
  for (const c of f.customers ?? [])
    await db.insert(customers).values({
      id: c.id,
      name: c.id,
      email: `${c.id}@example.com`,
      balance: c.balance ?? 0,
      creditLimit: c.creditLimit ?? 0,
    });
}

describeBalanceStoreContract('D1', async (fixture, clock) => {
  await seed(fixture);
  return d1BalanceStore(DB, clock);
});
