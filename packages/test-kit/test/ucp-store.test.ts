import { describeUcpStoreContract, InMemoryUcpStore } from '../src/commerce';

describeUcpStoreContract('in memory', async (fixture) => new InMemoryUcpStore(fixture));
