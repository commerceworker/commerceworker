import { env } from 'cloudflare:workers';
import { describeFlowStoreContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { d1FlowStore } from '../src/flow-store';
import { createDb } from '../src/index';
import { flows } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;
let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };

describeFlowStoreContract('D1', async () => {
  // Versions go with their flow (on delete cascade).
  await createDb(DB).delete(flows).where(like(flows.id, 'fc2_%'));
  return d1FlowStore(DB, clock);
});
