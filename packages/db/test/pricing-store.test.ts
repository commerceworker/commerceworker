import { env } from 'cloudflare:workers';
import { describePricingStoreContract } from '@commerceworker/test-kit/commerce';
import { d1PricingStore } from '../src/pricing-store';
import { seedPricing } from './seeds';

const DB = (env as unknown as { DB: D1Database }).DB;
const clock = { now: () => new Date('2026-11-01T00:00:00Z') };

describePricingStoreContract('D1', async (fixture) => {
  await seedPricing(fixture);
  return d1PricingStore(DB, clock);
});
