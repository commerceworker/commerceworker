import { env } from 'cloudflare:workers';
import { describeInvoiceStoreContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { d1InvoiceStore } from '../src/invoice-store';
import { d1PaymentLedger } from '../src/payment-ledger';
import { invoices, payments } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;
let tick = 0;
// The clock moves on between writes, so invoices read oldest first as the in-memory store does.
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };

describeInvoiceStoreContract('D1', async () => {
  const db = createDb(DB);
  await db.delete(invoices).where(like(invoices.orderId, 'ic_%'));
  await db.delete(payments).where(like(payments.orderId, 'ic_%'));
  return { invoices: d1InvoiceStore(DB, clock), ledger: d1PaymentLedger(DB, clock) };
});
