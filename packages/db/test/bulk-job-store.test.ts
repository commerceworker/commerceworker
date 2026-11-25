import { env } from 'cloudflare:workers';
import { describeBulkJobStoreContract } from '@commerceworker/test-kit/commerce';
import { d1BulkJobStore } from '../src/bulk-job-store';

const DB = (env as unknown as { DB: D1Database }).DB;

describeBulkJobStoreContract('D1', async () => {
  // The cases name their jobs blk_bj_*; a run starts without the last one's.
  await DB.prepare(`DELETE FROM bulk_jobs WHERE id LIKE 'blk_bj_%'`).run();
  return d1BulkJobStore(DB);
});
