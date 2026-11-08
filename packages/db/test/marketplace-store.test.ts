import { env } from 'cloudflare:workers';
import { describeMarketplaceStoreContract } from '@commerceworker/test-kit/commerce';
import { d1MarketplaceStore } from '../src/marketplace-store';
import { seedMarketplace } from './seeds';

const DB = (env as unknown as { DB: D1Database }).DB;
const clock = { now: () => new Date('2026-11-01T00:00:00Z') };

describeMarketplaceStoreContract('D1', async (fixture) => {
  await seedMarketplace(fixture);
  return d1MarketplaceStore(DB, clock);
});
