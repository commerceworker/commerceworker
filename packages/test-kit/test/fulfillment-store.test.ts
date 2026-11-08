import { describeFulfillmentStoreContract, InMemoryFulfillmentStore } from '../src/commerce';

describeFulfillmentStoreContract(
  'in memory',
  async (fixture) => new InMemoryFulfillmentStore(fixture),
);
