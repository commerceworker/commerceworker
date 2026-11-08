import { env } from 'cloudflare:workers';
import { describeFulfillmentStoreContract } from '@commerceworker/test-kit/commerce';
import { d1FulfillmentStore } from '../src/fulfillment-store';
import { seedFulfillment } from './seeds';

const DB = (env as unknown as { DB: D1Database }).DB;
const clock = { now: () => new Date('2026-11-01T00:00:00Z') };

describeFulfillmentStoreContract('D1', async (fixture) => {
  await seedFulfillment(fixture);
  return d1FulfillmentStore(DB, clock);
});
