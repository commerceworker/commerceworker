import { describeUcpLinksContract, InMemoryUcpLinks } from '../src/commerce';

describeUcpLinksContract('in-memory', async () => new InMemoryUcpLinks());
