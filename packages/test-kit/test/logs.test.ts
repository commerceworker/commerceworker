import {
  describeLogsContract,
  InMemoryIntakeLog,
  InMemoryPaymentEventLog,
  InMemoryUsageStore,
} from '../src/commerce';

describeLogsContract('in memory', async () => ({
  intake: new InMemoryIntakeLog(),
  events: new InMemoryPaymentEventLog(),
  usage: new InMemoryUsageStore(),
}));
