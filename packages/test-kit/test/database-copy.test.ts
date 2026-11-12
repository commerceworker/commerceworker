import { InMemoryDatabaseCopy } from '../src/commerce/database-copy';
import { describeDatabaseCopyContract } from '../src/commerce/database-copy-contract';

describeDatabaseCopyContract('in memory', async () => {
  const source = new InMemoryDatabaseCopy();
  const target = new InMemoryDatabaseCopy();
  return { source, target, unmarked: source, seed: async (ddl, rows) => source.seed(ddl, rows) };
});
