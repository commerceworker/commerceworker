import { describeInventoryStoreContract, InMemoryInventoryStore } from '../src/commerce';

describeInventoryStoreContract('in memory', async (fixture) => new InMemoryInventoryStore(fixture));
