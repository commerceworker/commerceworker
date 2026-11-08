import { describeAuthStoreContract, InMemoryAuthStore } from '../src/commerce';

describeAuthStoreContract('in memory', async (fixture) => new InMemoryAuthStore(fixture));
