import { describeAuditLogContract, InMemoryAuditLog } from '../src/commerce';

describeAuditLogContract('in memory', async () => new InMemoryAuditLog());
