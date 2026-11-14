import { env } from 'cloudflare:workers';
import { describeAdminSettingsContract } from '@commerceworker/test-kit/admin-settings-contract';
import { createAdminSettings } from '../src/admin-settings';

const DB = (env as unknown as { DB: D1Database }).DB;
describeAdminSettingsContract('D1', async () => {
  await DB.prepare("DELETE FROM workspace_settings WHERE key LIKE 'asc_%'").run();
  return createAdminSettings(DB);
});
