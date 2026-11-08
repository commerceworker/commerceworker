import { env } from 'cloudflare:workers';
import {
  describeSealedSecretsContract,
  type SealedFixture,
} from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { integrations, pluginSecrets, users, webhookSubscriptions } from '../src/schema';
import { d1SealedSecrets } from '../src/sealed-secrets';

const DB = (env as unknown as { DB: D1Database }).DB;

/** Each column's fixture values as rows of their tables. */
async function seed(f: SealedFixture) {
  const db = createDb(DB);
  await db.delete(users).where(like(users.id, 'ss_%'));
  await db.delete(webhookSubscriptions).where(like(webhookSubscriptions.id, 'ss_%'));
  await db.delete(integrations).where(like(integrations.id, 'ss_%'));
  await db.delete(pluginSecrets).where(like(pluginSecrets.pluginId, 'ss_%'));
  for (const [id, totp] of Object.entries(f['users.totp_secret'] ?? {}))
    await db.insert(users).values({
      id,
      email: `${id}@example.com`,
      name: id,
      role: 'admin',
      createdAt: 0,
      totpSecret: totp,
    });
  for (const [id, secret] of Object.entries(f['webhook_subscriptions.secret'] ?? {}))
    await db.insert(webhookSubscriptions).values({
      id,
      url: 'https://hooks.example',
      secret: secret ?? '',
      previousSecret: f['webhook_subscriptions.previous_secret']?.[id] ?? null,
      createdAt: 0,
    });
  for (const [id, secret] of Object.entries(f['integrations.secret'] ?? {}))
    await db.insert(integrations).values({
      id,
      name: id,
      secret: secret ?? '',
      previousSecret: f['integrations.previous_secret']?.[id] ?? null,
      createdAt: 0,
    });
  for (const [key, value] of Object.entries(f['plugin_secrets.value'] ?? {})) {
    const [pluginId, name] = key.split('/') as [string, string];
    await db
      .insert(pluginSecrets)
      .values({ pluginId, name, value: value ?? '', updatedBy: 'ss', updatedAt: 0 });
  }
}

describeSealedSecretsContract('D1', async (fixture) => {
  await seed(fixture);
  return d1SealedSecrets(DB);
});
