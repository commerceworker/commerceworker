import { env } from 'cloudflare:workers';
import { describeInventoryStoreContract } from '@commerceworker/test-kit/commerce';
import { d1InventoryStore } from '../src/inventory-store';
import { seedInventory } from './seeds';

const DB = (env as unknown as { DB: D1Database }).DB;
const clock = { now: () => new Date('2026-11-01T00:00:00Z') };

describeInventoryStoreContract('D1', async (fixture) => {
  await seedInventory(fixture);
  return d1InventoryStore(DB, clock);
});
