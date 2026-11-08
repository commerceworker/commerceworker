import { env } from 'cloudflare:workers';
import { describePluginInstallStoreContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { d1PluginInstallStore } from '../src/plugin-install-store';
import { installedPlugins, pluginErrors, pluginSecrets } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

describePluginInstallStoreContract('D1', async () => {
  const db = createDb(DB);
  await db.delete(installedPlugins).where(like(installedPlugins.id, 'pi_%'));
  await db.delete(pluginSecrets).where(like(pluginSecrets.pluginId, 'pi_%'));
  await db.delete(pluginErrors).where(like(pluginErrors.pluginId, 'pi_%'));
  return d1PluginInstallStore(DB);
});
