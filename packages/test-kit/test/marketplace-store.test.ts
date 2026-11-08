import { describeMarketplaceStoreContract, InMemoryMarketplaceStore } from '../src/commerce';

describeMarketplaceStoreContract(
  'in memory',
  async (fixture) => new InMemoryMarketplaceStore(fixture),
);
