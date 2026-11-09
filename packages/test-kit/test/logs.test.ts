import {
  describeLogsContract,
  InMemoryIntakeLog,
  InMemoryPaymentEventLog,
  InMemoryUsageStore,
  InMemoryWebhookReceipts,
} from '../src/commerce';

describeLogsContract('in memory', async () => ({
  intake: new InMemoryIntakeLog(),
  events: new InMemoryPaymentEventLog(),
  usage: new InMemoryUsageStore(),
  receipts: new InMemoryWebhookReceipts(),
}));
