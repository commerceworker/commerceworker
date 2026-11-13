import {
  describeAuditAnchorsContract,
  describeAuditLogContract,
  InMemoryAuditAnchors,
  InMemoryAuditLog,
} from '../src/commerce';

describeAuditLogContract('in memory', async () => new InMemoryAuditLog());
describeAuditAnchorsContract('in memory', async () => new InMemoryAuditAnchors());
