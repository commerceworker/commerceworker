import {
  describePriceBookStoreContract,
  InMemoryPriceBookStore,
  InMemoryPricingStore,
  PRICING_FIXTURE,
  PriceBookData,
} from '../src/commerce';
import { FixedClock } from '../src/fakes';

describePriceBookStoreContract('in memory', async () => {
  const data = new PriceBookData();
  return {
    books: new InMemoryPriceBookStore(data),
    pricing: new InMemoryPricingStore(
      PRICING_FIXTURE,
      new FixedClock(new Date('2026-11-01T00:00:00Z')),
      data,
    ),
  };
});
