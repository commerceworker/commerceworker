import { env } from 'cloudflare:workers';
import { describeAuditLogContract } from '@commerceworker/test-kit/commerce';
import { d1AuditLog } from '../src/audit-log';

const DB = (env as unknown as { DB: D1Database }).DB;

// The audit table refuses deletes of young events, so each case appends to the chain as it stands.
describeAuditLogContract('D1', async () => d1AuditLog(DB));
