import { describeBulkJobStoreContract, InMemoryBulkJobStore } from '../src/commerce';

describeBulkJobStoreContract('in-memory', async () => new InMemoryBulkJobStore());
