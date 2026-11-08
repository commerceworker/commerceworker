import { describeCartRecordsContract, InMemoryCartRecords } from '../src/commerce';

describeCartRecordsContract('in memory', async () => new InMemoryCartRecords());
