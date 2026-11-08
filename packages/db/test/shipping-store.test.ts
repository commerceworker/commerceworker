import { env } from 'cloudflare:workers';
import { describeShippingStoreContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { shipments } from '../src/schema';
import { d1ShippingStore } from '../src/shipping-store';

const DB = (env as unknown as { DB: D1Database }).DB;
let tick = 0;
// Each booking a moment later, so `voidFailed` reads oldest first as the in-memory store does.
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };

describeShippingStoreContract('D1', async () => {
  await createDb(DB).delete(shipments).where(like(shipments.id, 'sc_%'));
  return d1ShippingStore(DB, clock);
});
