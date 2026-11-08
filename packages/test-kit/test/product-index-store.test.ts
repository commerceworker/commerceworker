import { describeProductIndexStoreContract, InMemoryProductIndexStore } from '../src/commerce';

describeProductIndexStoreContract(
  'in memory',
  async (fixture) => new InMemoryProductIndexStore(fixture),
);
