import { describeBalanceStoreContract, InMemoryBalanceStore } from '../src/commerce';

describeBalanceStoreContract(
  'in memory',
  async (fixture, clock) => new InMemoryBalanceStore(fixture, clock),
);
