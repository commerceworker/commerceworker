import { describeOrderQueriesContract, InMemoryOrderQueries } from '../src/commerce';

describeOrderQueriesContract('in memory', async (fixture) => new InMemoryOrderQueries(fixture));
