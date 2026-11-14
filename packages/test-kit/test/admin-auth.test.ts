import { InMemoryAdminAuth } from '../src/admin-auth';
import { describeAdminAuthContract } from '../src/admin-auth-contract';

describeAdminAuthContract('in memory', async (f) => new InMemoryAdminAuth(f));
