import { env } from 'cloudflare:workers';
import { describeAdminAuditLogContract } from '@commerceworker/test-kit/admin-audit-log-contract';
import { createAdminAuditLog } from '../src/admin-audit-log';
import { adminAudit, authDbOf } from '../src/auth';

const DB = (env as unknown as { DB: D1Database }).DB;
describeAdminAuditLogContract('D1', async (seed = []) => {
  // Contract events date from 1970, past the trigger's retention floor.
  const db = authDbOf(DB);
  await db.delete(adminAudit);
  for (const row of seed) await db.insert(adminAudit).values(row);
  return createAdminAuditLog(DB);
});
