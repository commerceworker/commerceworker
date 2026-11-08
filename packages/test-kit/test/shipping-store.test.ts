import { describeShippingStoreContract, InMemoryShippingStore } from '../src/commerce';

let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };

describeShippingStoreContract('in memory', async () => new InMemoryShippingStore(clock));
