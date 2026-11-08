import { describeCheckoutSessionsContract, InMemoryCheckoutSessions } from '../src/commerce';

describeCheckoutSessionsContract('in memory', async () => new InMemoryCheckoutSessions());
