import { env } from 'cloudflare:workers';
import { describeQuoteStoreContract, PRICING_FIXTURE } from '@commerceworker/test-kit/commerce';
import { d1PricingStore } from '../src/pricing-store';
import { d1QuoteStore } from '../src/quote-store';
import { seedPricing } from './seeds';

const DB = (env as unknown as { DB: D1Database }).DB;
const clock = { now: () => new Date('2026-11-01T00:00:00Z') };

describeQuoteStoreContract('D1', async () => {
  // The cases name their quotes qtct_*; a run starts without the last one's.
  await DB.batch([
    DB.prepare(`DELETE FROM quote_lines WHERE quote_id LIKE 'qtct_%'`),
    DB.prepare(`DELETE FROM quotes WHERE id LIKE 'qtct_%'`),
    DB.prepare(`DELETE FROM contract_prices WHERE customer_id LIKE 'pc_%'`),
  ]);
  await seedPricing(PRICING_FIXTURE);
  return { quotes: d1QuoteStore(DB), pricing: d1PricingStore(DB, clock) };
});
