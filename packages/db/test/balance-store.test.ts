import { env } from 'cloudflare:workers';
import {
  type BalanceFixture,
  describeBalanceStoreContract,
} from '@commerceworker/test-kit/commerce';
import { inArray, like } from 'drizzle-orm';
import { d1BalanceStore } from '../src/balance-store';
import { createDb } from '../src/index';
import { balanceEntries, customers } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;
const clock = { now: () => new Date('2026-11-01T00:00:00Z') };

/** Resets the fixture's customers and every contract order's ledger, so each case starts the same. */
async function seed(f: BalanceFixture) {
  const db = createDb(DB);
  await db.delete(balanceEntries).where(like(balanceEntries.orderId, 'bc_%'));
  const ids = (f.customers ?? []).map((c) => c.id);
  if (ids.length) await db.delete(customers).where(inArray(customers.id, ids));
  for (const c of f.customers ?? [])
    await db
      .insert(customers)
      .values({ id: c.id, name: c.id, email: `${c.id}@example.com`, balance: c.balance ?? 0 });
}

describeBalanceStoreContract('D1', async (fixture) => {
  await seed(fixture);
  return d1BalanceStore(DB, clock);
});
