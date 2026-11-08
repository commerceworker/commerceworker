import { env } from 'cloudflare:workers';
import { describeCartRecordsContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { d1CartRecords } from '../src/cart-records';
import { createDb } from '../src/index';
import { carts } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;
const clock = { now: () => new Date('2026-11-01T00:00:00Z') };

describeCartRecordsContract('D1', async () => {
  await createDb(DB).delete(carts).where(like(carts.id, 'crc_%'));
  return d1CartRecords(DB, clock);
});
