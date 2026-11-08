import { describeIntegrationStoreContract, InMemoryIntegrationStore } from '../src/commerce';

describeIntegrationStoreContract(
  'in memory',
  async (fixture) => new InMemoryIntegrationStore(fixture),
);
