/**
 * The plugin installs port (`PluginInstallStore`, @commerceworker/ports/commerce) on D1:
 * `installed_plugins`, `plugin_secrets` and `plugin_errors`. Moved here from the engine's plugin
 * installs and host. `installed_plugins_running` (one active or disabled row per id) and
 * `installed_plugins_version` back the guards. The contract in @commerceworker/test-kit/commerce
 * holds this and the in-memory store to the same behaviour.
 */
import type { PluginInstallStore } from '@commerceworker/ports/commerce';
import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { createDb } from './index';
import { installedPlugins, pluginErrors, pluginSecrets } from './schema';
import { uniqueViolation } from './unique';

const changed = (r: unknown) => ((r as D1Result).meta?.changes ?? 0) > 0;

export function d1PluginInstallStore(d1: D1Database): PluginInstallStore {
  const d = createDb(d1);
  return {
    versions: (id) => d.select().from(installedPlugins).where(eq(installedPlugins.id, id)),

    all: () => d.select().from(installedPlugins),

    async active() {
      const rows = await d
        .select({
          id: installedPlugins.id,
          sha: installedPlugins.sha,
          personalData: installedPlugins.personalDataGranted,
          publisher: installedPlugins.publisher,
        })
        .from(installedPlugins)
        .where(eq(installedPlugins.status, 'active'));
      return rows.map((r) => ({ ...r, personalData: r.personalData === 1 }));
    },

    async activeSha(id) {
      const row = await d
        .select({ sha: installedPlugins.sha })
        .from(installedPlugins)
        .where(and(eq(installedPlugins.id, id), eq(installedPlugins.status, 'active')))
        .get();
      return row?.sha;
    },

    async upload(row) {
      try {
        await d
          .insert(installedPlugins)
          .values(row)
          // Only an uninstalled row of the same file is replaced, and wholly: never one that runs.
          .onConflictDoUpdate({
            target: [installedPlugins.id, installedPlugins.sha],
            set: {
              publisher: row.publisher,
              status: 'pending',
              personalDataGranted: 0,
              uploadedBy: row.uploadedBy,
              uploadedAt: row.uploadedAt,
              approvedBy: null,
              approvedAt: null,
              request: row.request,
              cases: row.cases,
            },
            setWhere: eq(installedPlugins.status, 'uninstalled'),
          });
        return 'ok';
      } catch (err) {
        // Two drafts (or uploads) of one version at once: `installed_plugins_version` lets one in.
        if (uniqueViolation(err)) return 'conflict';
        throw err;
      }
    },

    async activate(v, from, set) {
      const still = sql`exists (select 1 from installed_plugins t where t.id = ${v.id} and t.sha = ${v.sha} and t.status = ${from})`;
      const [, activated] = await d.batch([
        d
          .update(installedPlugins)
          .set({ status: 'superseded' })
          .where(
            and(
              eq(installedPlugins.id, v.id),
              ne(installedPlugins.sha, v.sha),
              inArray(installedPlugins.status, ['active', 'disabled']),
              still,
            ),
          ),
        d
          .update(installedPlugins)
          .set({ ...set, status: 'active' })
          .where(
            and(
              eq(installedPlugins.id, v.id),
              eq(installedPlugins.sha, v.sha),
              eq(installedPlugins.status, from),
            ),
          ),
      ]);
      return changed(activated);
    },

    async setStatus(id, sha, from, to) {
      const r = await d
        .update(installedPlugins)
        .set({ status: to })
        .where(
          and(
            eq(installedPlugins.id, id),
            eq(installedPlugins.sha, sha),
            eq(installedPlugins.status, from),
          ),
        );
      return changed(r);
    },

    async setCases(id, sha, prev, next) {
      const r = await d
        .update(installedPlugins)
        .set({ cases: next })
        .where(
          and(
            eq(installedPlugins.id, id),
            eq(installedPlugins.sha, sha),
            prev === null ? isNull(installedPlugins.cases) : eq(installedPlugins.cases, prev),
          ),
        );
      return changed(r);
    },

    async uninstall(id) {
      await d.batch([
        d
          .update(installedPlugins)
          .set({ status: 'uninstalled' })
          .where(eq(installedPlugins.id, id)),
        d.delete(pluginSecrets).where(eq(pluginSecrets.pluginId, id)),
      ]);
    },

    async secret(id, name) {
      const row = await d
        .select({ value: pluginSecrets.value })
        .from(pluginSecrets)
        .where(and(eq(pluginSecrets.pluginId, id), eq(pluginSecrets.name, name)))
        .get();
      return row?.value;
    },

    async setSecret(id, name, sealed, by) {
      const now = Date.now();
      await d
        .insert(pluginSecrets)
        .values({ pluginId: id, name, value: sealed, updatedBy: by, updatedAt: now })
        .onConflictDoUpdate({
          target: [pluginSecrets.pluginId, pluginSecrets.name],
          set: { value: sealed, updatedBy: by, updatedAt: now },
        });
    },

    errors: (id, limit) =>
      d
        .select({ id: pluginErrors.id, message: pluginErrors.message, at: pluginErrors.at })
        .from(pluginErrors)
        .where(eq(pluginErrors.pluginId, id))
        .orderBy(desc(pluginErrors.at))
        .limit(limit),
    async recordErrors(id, errors, keep) {
      if (!errors.length) return;
      for (const e of errors)
        await d
          .insert(pluginErrors)
          .values({ id: crypto.randomUUID(), pluginId: id, message: e.message, at: e.at });
      // Only the latest are kept (pruned only when something was added).
      const kept = d
        .select({ id: pluginErrors.id })
        .from(pluginErrors)
        .where(eq(pluginErrors.pluginId, id))
        .orderBy(desc(pluginErrors.at))
        .limit(keep);
      await d
        .delete(pluginErrors)
        .where(and(eq(pluginErrors.pluginId, id), notInArray(pluginErrors.id, kept)));
    },
  };
}
