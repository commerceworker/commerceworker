import { env } from 'cloudflare:workers';
import { describeShopperAuthContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/index';
import { shopperSessions, shopperSignIns } from '../src/schema';
import { d1ShopperAuth } from '../src/shopper-auth';

const { DB } = env as unknown as { DB: D1Database };

describeShopperAuthContract('D1', async () => {
  const db = createDb(DB);
  await db.delete(shopperSignIns).where(like(shopperSignIns.email, '%@shopper.test'));
  await db.delete(shopperSessions).where(like(shopperSessions.email, '%@shopper.test'));
  return d1ShopperAuth(DB);
});

describe('what D1 keeps', () => {
  it('has an index to find an address’s orders by, which the planner uses', async () => {
    const plan = await DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM orders WHERE lower(contact_email) = 'a@b.test'",
    ).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(' ')).toContain('orders_contact_email');
  });
});
