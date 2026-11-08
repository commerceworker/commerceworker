import { describeOrderBoardContract, InMemoryOrderBoard } from '../src/commerce';

describeOrderBoardContract('in memory', async (fixture) => new InMemoryOrderBoard(fixture));
