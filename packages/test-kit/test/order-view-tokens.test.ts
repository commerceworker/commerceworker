import { describeOrderViewTokensContract, InMemoryOrderViewTokens } from '../src/commerce';

describeOrderViewTokensContract('in memory', async () => new InMemoryOrderViewTokens());
