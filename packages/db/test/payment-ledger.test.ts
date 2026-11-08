import { env } from 'cloudflare:workers';
import {
  describePaymentLedgerContract,
  type PaymentLedgerFixture,
} from '@commerceworker/test-kit/commerce';
import { inArray, like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { d1PaymentLedger } from '../src/payment-ledger';
import { customers, payments } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;
let tick = 0;
// The clock moves on between writes, so rows read oldest first as the in-memory ledger does.
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };

/** Resets the fixture's customers and every contract order's payments. */
async function seed(f: PaymentLedgerFixture) {
  const db = createDb(DB);
  await db.delete(payments).where(like(payments.orderId, 'pc_%'));
  const ids = (f.customers ?? []).map((c) => c.id);
  if (ids.length) await db.delete(customers).where(inArray(customers.id, ids));
  for (const c of f.customers ?? [])
    await db.insert(customers).values({
      id: c.id,
      name: c.name,
      email: c.email,
      stripeCustomerId: c.stripeCustomerId,
      stripePaymentMethodId: c.paymentMethodId,
    });
}

describePaymentLedgerContract('D1', async (fixture) => {
  await seed(fixture);
  return d1PaymentLedger(DB, clock);
});
