import { describeScimDirectoryContract, InMemoryScimDirectory } from '../src/commerce';

describeScimDirectoryContract('in memory', async (fixture) => new InMemoryScimDirectory(fixture));
