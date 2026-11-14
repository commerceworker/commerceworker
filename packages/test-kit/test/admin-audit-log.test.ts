import { InMemoryAdminAuditLog } from '../src/admin-audit-log';
import { describeAdminAuditLogContract } from '../src/admin-audit-log-contract';

describeAdminAuditLogContract('in memory', async (seed) => new InMemoryAdminAuditLog(seed));
