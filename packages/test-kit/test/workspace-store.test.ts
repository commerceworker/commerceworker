import { describeWorkspaceStoreContract, InMemoryWorkspaceStore } from '../src/commerce';

describeWorkspaceStoreContract('in memory', async (fixture) => new InMemoryWorkspaceStore(fixture));
