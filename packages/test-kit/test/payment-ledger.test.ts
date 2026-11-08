import { describePaymentLedgerContract, InMemoryPaymentLedger } from '../src/commerce';

let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };

describePaymentLedgerContract(
  'in memory',
  async (fixture) => new InMemoryPaymentLedger(fixture, clock),
);
