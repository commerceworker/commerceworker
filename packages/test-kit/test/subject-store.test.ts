import { describeSubjectStoreContract, InMemorySubjectStore } from '../src/commerce';

describeSubjectStoreContract('in memory', async (fixture) => new InMemorySubjectStore(fixture));
