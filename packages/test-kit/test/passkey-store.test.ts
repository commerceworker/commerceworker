import { describePasskeyStoreContract, InMemoryPasskeyStore } from '../src/commerce';

describePasskeyStoreContract('in memory', async (fixture) => new InMemoryPasskeyStore(fixture));
