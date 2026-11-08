import { describeFlowStoreContract, InMemoryFlowStore } from '../src/commerce';

let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };

describeFlowStoreContract('in memory', async () => new InMemoryFlowStore(clock));
