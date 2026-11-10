import { env } from 'cloudflare:workers';
import { describePriceBookStoreContract, PRICING_FIXTURE } from '@commerceworker/test-kit/commerce';
import { d1PriceBookStore } from '../src/price-book-store';
import { d1PricingStore } from '../src/pricing-store';
import { seedPricing } from './seeds';

const DB = (env as unknown as { DB: D1Database }).DB;
const clock = { now: () => new Date('2026-11-01T00:00:00Z') };

describePriceBookStoreContract('D1', async () => {
  await seedPricing(PRICING_FIXTURE);
  // The cases name their books pcb_* and pcl-*; a run starts without the last one's.
  await DB.batch([
    DB.prepare(
      `DELETE FROM price_book_assignments WHERE book_id IN (SELECT id FROM price_books WHERE id LIKE 'pcb_%')`,
    ),
    DB.prepare(
      `DELETE FROM price_rules WHERE book_id IN (SELECT id FROM price_books WHERE id LIKE 'pcb_%')`,
    ),
    DB.prepare(`DELETE FROM price_books WHERE id LIKE 'pcb_%'`),
    DB.prepare(`DELETE FROM contract_prices WHERE customer_id LIKE 'pc_%'`),
  ]);
  await seedPricing(PRICING_FIXTURE);
  return { books: d1PriceBookStore(DB), pricing: d1PricingStore(DB, clock) };
});
