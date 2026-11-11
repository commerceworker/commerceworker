import {
  describeQuoteStoreContract,
  InMemoryPricingStore,
  InMemoryQuoteStore,
  PRICING_FIXTURE,
  PriceBookData,
  QuoteData,
} from '../src/commerce';
import { FixedClock } from '../src/fakes';

describeQuoteStoreContract('in memory', async () => {
  const quotes = new QuoteData();
  return {
    quotes: new InMemoryQuoteStore(quotes),
    pricing: new InMemoryPricingStore(
      PRICING_FIXTURE,
      new FixedClock(new Date('2026-11-01T00:00:00Z')),
      new PriceBookData(),
      quotes,
    ),
  };
});
