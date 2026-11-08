import { describePricingStoreContract, InMemoryPricingStore } from '../src/commerce';
import { FixedClock } from '../src/fakes';

describePricingStoreContract(
  'in memory',
  async (fixture) =>
    new InMemoryPricingStore(fixture, new FixedClock(new Date('2026-11-01T00:00:00Z'))),
);
