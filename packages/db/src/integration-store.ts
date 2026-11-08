/**
 * The integrations port over D1: `integrations`. Moved here from the web app's integrations API.
 * A rotation moves the current secret across in the same statement, and a revocation is guarded
 * on the integration still being live. The contract in @commerceworker/test-kit/commerce holds
 * this and the in-memory store to the same behaviour.
 */
import type { IntegrationStore } from '@commerceworker/ports/commerce';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { createDb } from './index';
import { integrations } from './schema';

/** An integration as the admin API shows it: never a secret. */
const view = {
  id: integrations.id,
  name: integrations.name,
  events: integrations.events,
  startOrders: integrations.startOrders,
  flows: integrations.flows,
  channel: integrations.channel,
  createdAt: integrations.createdAt,
  createdBy: integrations.createdBy,
  lastUsedAt: integrations.lastUsedAt,
  revokedAt: integrations.revokedAt,
  previousExpiresAt: integrations.previousExpiresAt,
};

const live = (id: string) => and(eq(integrations.id, id), isNull(integrations.revokedAt));

export function d1IntegrationStore(d1: D1Database): IntegrationStore {
  const d = createDb(d1);
  return {
    list: (limit) =>
      d.select(view).from(integrations).orderBy(desc(integrations.createdAt)).limit(limit),
    async add(i) {
      await d.insert(integrations).values(i);
    },
    async rotate(id, secret, previousUntil) {
      // The current secret moves across in the same statement, still sealed for this row.
      const [row] = await d
        .update(integrations)
        .set({
          previousSecret: sql`${integrations.secret}`,
          secret,
          previousExpiresAt: previousUntil,
        })
        .where(live(id))
        .returning(view);
      return row;
    },
    async revoke(id, at) {
      const [row] = await d
        .update(integrations)
        .set({ revokedAt: at, previousSecret: null, previousExpiresAt: null })
        .where(live(id))
        .returning(view);
      return row;
    },
    active: (id) =>
      d
        .select({
          ...view,
          secret: integrations.secret,
          previousSecret: integrations.previousSecret,
        })
        .from(integrations)
        .where(live(id))
        .get(),
    async touch(id, at) {
      await d.update(integrations).set({ lastUsedAt: at }).where(eq(integrations.id, id));
    },
  };
}
