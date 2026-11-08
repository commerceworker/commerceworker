import {
  describeDocumentStoreContract,
  InMemoryDocumentStore,
  InMemoryMessageStore,
} from '../src/commerce';

describeDocumentStoreContract('in memory', async () => ({
  documents: new InMemoryDocumentStore(),
  messages: new InMemoryMessageStore(),
}));
