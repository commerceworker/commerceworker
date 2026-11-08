/**
 * The sealed secrets port (`SealedSecretStore`, @commerceworker/ports/commerce) on D1: every
 * column that holds a value sealed with `DATA_KEY`. Moved here from the engine's resealing sweep.
 * The contract in @commerceworker/test-kit/commerce holds this and the in-memory store to the same
 * behaviour.
 */
import type { SealedColumn, SealedSecretStore } from '@commerceworker/ports/commerce';
import { and, eq, isNotNull } from 'drizzle-orm';
import { createDb, type Db } from './index';
import { integrations, pluginSecrets, users, webhookSubscriptions } from './schema';

type Column = {
  rows: (d: Db) => Promise<{ id: string; value: string | null }[]>;
  write: (d: Db, id: string, was: string, next: string) => Promise<D1Result | unknown>;
};

const COLUMNS: Record<SealedColumn, Column> = {
  'users.totp_secret': {
    rows: (d) =>
      d
        .select({ id: users.id, value: users.totpSecret })
        .from(users)
        .where(isNotNull(users.totpSecret)),
    write: (d, id, was, next) =>
      d
        .update(users)
        .set({ totpSecret: next })
        .where(and(eq(users.id, id), eq(users.totpSecret, was))),
  },
  'webhook_subscriptions.secret': {
    rows: (d) =>
      d
        .select({ id: webhookSubscriptions.id, value: webhookSubscriptions.secret })
        .from(webhookSubscriptions),
    write: (d, id, was, next) =>
      d
        .update(webhookSubscriptions)
        .set({ secret: next })
        .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.secret, was))),
  },
  'webhook_subscriptions.previous_secret': {
    rows: (d) =>
      d
        .select({ id: webhookSubscriptions.id, value: webhookSubscriptions.previousSecret })
        .from(webhookSubscriptions)
        .where(isNotNull(webhookSubscriptions.previousSecret)),
    write: (d, id, was, next) =>
      d
        .update(webhookSubscriptions)
        .set({ previousSecret: next })
        .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.previousSecret, was))),
  },
  'integrations.secret': {
    rows: (d) => d.select({ id: integrations.id, value: integrations.secret }).from(integrations),
    write: (d, id, was, next) =>
      d
        .update(integrations)
        .set({ secret: next })
        .where(and(eq(integrations.id, id), eq(integrations.secret, was))),
  },
  'integrations.previous_secret': {
    rows: (d) =>
      d
        .select({ id: integrations.id, value: integrations.previousSecret })
        .from(integrations)
        .where(isNotNull(integrations.previousSecret)),
    write: (d, id, was, next) =>
      d
        .update(integrations)
        .set({ previousSecret: next })
        .where(and(eq(integrations.id, id), eq(integrations.previousSecret, was))),
  },
  'plugin_secrets.value': {
    rows: async (d) =>
      (
        await d
          .select({
            pluginId: pluginSecrets.pluginId,
            name: pluginSecrets.name,
            value: pluginSecrets.value,
          })
          .from(pluginSecrets)
      ).map((r) => ({ id: `${r.pluginId}/${r.name}`, value: r.value })),
    write: (d, id, was, next) => {
      const [pluginId, name] = id.split('/') as [string, string];
      return d
        .update(pluginSecrets)
        .set({ value: next })
        .where(
          and(
            eq(pluginSecrets.pluginId, pluginId),
            eq(pluginSecrets.name, name),
            eq(pluginSecrets.value, was),
          ),
        );
    },
  },
};

export function d1SealedSecrets(d1: D1Database): SealedSecretStore {
  const d = createDb(d1);
  return {
    async values(column) {
      return (await COLUMNS[column].rows(d)).flatMap((r) =>
        r.value ? [{ column, id: r.id, value: r.value }] : [],
      );
    },
    async replace(column, id, was, next) {
      const r = await COLUMNS[column].write(d, id, was, next);
      return (((r as D1Result).meta?.changes ?? 0) as number) > 0;
    },
  };
}
