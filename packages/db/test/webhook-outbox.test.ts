import { env } from 'cloudflare:workers';
import {
  describeWebhookOutboxContract,
  type OutboxFixture,
} from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { webhookDeliveries, webhookSubscriptions } from '../src/schema';
import { d1WebhookOutbox } from '../src/webhook-outbox';

const DB = (env as unknown as { DB: D1Database }).DB;

async function seed(f: OutboxFixture) {
  const db = createDb(DB);
  await db.delete(webhookDeliveries).where(like(webhookDeliveries.id, 'wo_%'));
  await db.delete(webhookSubscriptions).where(like(webhookSubscriptions.id, 'wo_%'));
  for (const s of f.subscriptions ?? [])
    await db.insert(webhookSubscriptions).values({ createdAt: 0, ...s, active: s.active ?? true });
}

describeWebhookOutboxContract('D1', async (fixture) => {
  await seed(fixture);
  return d1WebhookOutbox(DB);
});
