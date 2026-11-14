import { InMemoryAdminScimDirectory } from '../src/admin-scim-directory';
import { describeAdminScimDirectoryContract } from '../src/admin-scim-directory-contract';

describeAdminScimDirectoryContract('in memory', async (f) => new InMemoryAdminScimDirectory(f));
