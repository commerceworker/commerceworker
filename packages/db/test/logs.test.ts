import { env } from 'cloudflare:workers';
import { describeLogsContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { d1IntakeLog, d1PaymentEventLog, d1UsageStore } from '../src/logs';
import { aiUsage, inboundEmails, paymentEvents } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

describeLogsContract('D1', async () => {
  const db = createDb(DB);
  await db.delete(inboundEmails).where(like(inboundEmails.id, 'lg_%'));
  await db.delete(paymentEvents).where(like(paymentEvents.id, 'lg_%'));
  await db.delete(aiUsage).where(like(aiUsage.principalId, 'lg_%'));
  return { intake: d1IntakeLog(DB), events: d1PaymentEventLog(DB), usage: d1UsageStore(DB) };
});
