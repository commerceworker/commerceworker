import type { AdminSettings } from '@commerceworker/ports';
import { and, eq, ne } from 'drizzle-orm';
import { authDbOf } from './auth';
import { workspaceSettings } from './auth-schema';

export function createAdminSettings(d1: D1Database): AdminSettings {
  const db = authDbOf(d1);
  return {
    record: (key) =>
      db.select().from(workspaceSettings).where(eq(workspaceSettings.key, key)).get(),
    async remove(key) {
      await db.delete(workspaceSettings).where(eq(workspaceSettings.key, key));
    },
    async get(key) {
      return (
        await db
          .select({ value: workspaceSettings.value })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.key, key))
          .get()
      )?.value;
    },
    async set(setting) {
      await db.insert(workspaceSettings).values(setting).onConflictDoUpdate({
        target: workspaceSettings.key,
        set: setting,
      });
    },
    async claim(setting) {
      const rows = await db
        .insert(workspaceSettings)
        .values(setting)
        .onConflictDoUpdate({
          target: workspaceSettings.key,
          set: setting,
          setWhere: ne(workspaceSettings.value, setting.value),
        })
        .returning({ key: workspaceSettings.key });
      return rows.length > 0;
    },
    async release(key, claimed, previous) {
      const owned = and(eq(workspaceSettings.key, key), eq(workspaceSettings.value, claimed));
      if (previous === undefined) await db.delete(workspaceSettings).where(owned);
      else await db.update(workspaceSettings).set({ value: previous }).where(owned);
    },
  };
}
