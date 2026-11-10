import { describeCompanyDirectoryContract, InMemoryCompanyDirectory } from '../src/commerce';

describeCompanyDirectoryContract('in memory', async () => new InMemoryCompanyDirectory());
