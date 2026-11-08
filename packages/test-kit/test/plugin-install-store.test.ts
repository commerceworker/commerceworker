import { describePluginInstallStoreContract, InMemoryPluginInstallStore } from '../src/commerce';

describePluginInstallStoreContract('in memory', async () => new InMemoryPluginInstallStore());
