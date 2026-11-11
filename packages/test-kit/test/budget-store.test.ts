import { describeBudgetStoreContract, InMemoryBudgetStore } from '../src/commerce';

describeBudgetStoreContract('in memory', async () => new InMemoryBudgetStore());
