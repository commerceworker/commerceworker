import { describeRetentionStoreContract, InMemoryRetentionStore } from '../src/commerce';

describeRetentionStoreContract('in memory', async (fixture) => new InMemoryRetentionStore(fixture));
