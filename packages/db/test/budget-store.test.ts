import { env } from 'cloudflare:workers';
import { describeBudgetStoreContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { d1BudgetStore } from '../src/budget-store';
import { createDb } from '../src/index';
import { budgetSpend, budgets } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

describeBudgetStoreContract('D1', async () => {
  const db = createDb(DB);
  await db.delete(budgetSpend).where(like(budgetSpend.budgetId, 'bd_%'));
  await db.delete(budgets).where(like(budgets.id, 'bd_%'));
  return d1BudgetStore(DB);
});
