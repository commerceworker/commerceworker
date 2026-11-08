import {
  describeConfirmationStoreContract,
  describeIdentityStoreContract,
  InMemoryConfirmationStore,
  InMemoryIdentityStore,
} from '../src/commerce';

describeIdentityStoreContract('in memory', async (fixture) => new InMemoryIdentityStore(fixture));
describeConfirmationStoreContract('in memory', async () => new InMemoryConfirmationStore());
