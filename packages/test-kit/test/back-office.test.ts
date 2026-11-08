import { describeBackOfficeContract, InMemoryBackOffice } from '../src/commerce';

describeBackOfficeContract('in memory', async (fixture) => new InMemoryBackOffice(fixture));
