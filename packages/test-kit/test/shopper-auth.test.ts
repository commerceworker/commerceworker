import { describeShopperAuthContract, InMemoryShopperAuth } from '../src/commerce';

describeShopperAuthContract('in-memory', async () => new InMemoryShopperAuth());
