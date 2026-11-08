import { describeWebhookOutboxContract, InMemoryWebhookOutbox } from '../src/commerce';

describeWebhookOutboxContract('in memory', async (fixture) => new InMemoryWebhookOutbox(fixture));
