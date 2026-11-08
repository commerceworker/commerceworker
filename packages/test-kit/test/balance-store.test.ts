import { describeBalanceStoreContract, InMemoryBalanceStore } from '../src/commerce';

describeBalanceStoreContract('in memory', async (fixture) => new InMemoryBalanceStore(fixture));
