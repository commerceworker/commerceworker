import { describeOrderRecordsContract, InMemoryOrderRecords } from '../src/commerce';

let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 1) + tick++) };

describeOrderRecordsContract(
  'in memory',
  async (fixture) => new InMemoryOrderRecords(fixture, clock),
);
