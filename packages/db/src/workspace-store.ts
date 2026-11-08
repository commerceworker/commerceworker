/**
 * The workspace port (`WorkspaceStore`, @commerceworker/ports/commerce) on D1: `users`,
 * `api_tokens` and `workspace_settings`. Moved here from the workspace assistant and the engine's
 * settings readers. The contract in @commerceworker/test-kit/commerce holds this and the in-memory
 * store to the same behaviour.
 */
import type { Clock } from '@commerceworker/ports';
import type { WorkspaceStore } from '@commerceworker/ports/commerce';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { createDb } from './index';
import { apiTokens, users, workspaceSettings } from './schema';

export function d1WorkspaceStore(d1: D1Database, clock: Clock): WorkspaceStore {
  const d = createDb(d1);
  const now = () => clock.now().getTime();
  return {
    async team() {
      const [people, tokens] = await d.batch([
        d
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            createdAt: users.createdAt,
            lastLoginAt: users.lastLoginAt,
            disabledAt: users.disabledAt,
            twoFactorAt: users.totpEnabledAt,
            passwordChangeDue: users.passwordChangeDue,
          })
          .from(users)
          .orderBy(users.email),
        d
          .select({
            id: apiTokens.id,
            name: apiTokens.name,
            prefix: apiTokens.prefix,
            role: apiTokens.role,
            createdBy: apiTokens.createdBy,
            // Aliased: D1's batch keys a row by column name, and `users.created_at` is selected too.
            createdAt: sql<number>`${apiTokens.createdAt}`.as('token_created_at'),
            lastUsedAt: apiTokens.lastUsedAt,
            revokedAt: apiTokens.revokedAt,
            expiresAt: apiTokens.expiresAt,
          })
          .from(apiTokens)
          .orderBy(desc(apiTokens.createdAt)),
      ]);
      return { people, tokens };
    },

    async setDisabled(id, at) {
      await d.update(users).set({ disabledAt: at }).where(eq(users.id, id));
    },

    async addToken(t) {
      await d.insert(apiTokens).values(t);
    },

    async revokeToken(id, at) {
      const [gone] = await d
        .update(apiTokens)
        .set({ revokedAt: at })
        .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
        .returning({ name: apiTokens.name, prefix: apiTokens.prefix });
      return gone;
    },

    member: (id) =>
      d
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          disabledAt: users.disabledAt,
        })
        .from(users)
        .where(eq(users.id, id))
        .get(),

    async hasOtherAdmin(exceptId) {
      const other = await d
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, exceptId)))
        .get();
      return !!other;
    },

    async setRole(id, role) {
      const keeps =
        role === 'admin'
          ? undefined
          : sql`exists (select 1 from ${users} as other where other.role = 'admin' and other.disabled_at is null and other.id <> ${id})`;
      const changed = await d
        .update(users)
        .set({ role })
        .where(and(eq(users.id, id), keeps))
        .returning({ id: users.id });
      return changed.length > 0;
    },

    async revokeTokens(member, roles) {
      if (roles && !roles.length) return 0;
      const ended = await d
        .update(apiTokens)
        .set({ revokedAt: now() })
        .where(
          and(
            or(
              eq(apiTokens.createdById, member.id),
              and(isNull(apiTokens.createdById), eq(apiTokens.createdBy, member.email)),
            ),
            isNull(apiTokens.revokedAt),
            roles ? inArray(apiTokens.role, [...roles]) : undefined,
          ),
        )
        .returning({ id: apiTokens.id });
      return ended.length;
    },

    admins: (limit) =>
      d
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
        .orderBy(users.name)
        .limit(limit),

    async names(ids) {
      const unique = [...new Set(ids)];
      const out: { id: string; name: string }[] = [];
      for (let i = 0; i < unique.length; i += 90)
        out.push(
          ...(await d
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, unique.slice(i, i + 90)))),
        );
      return out;
    },

    async setting(key) {
      const row = await d
        .select({ value: workspaceSettings.value })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.key, key))
        .get();
      return row?.value;
    },

    async claimSetting(key, value, by) {
      const at = now();
      const claimed = await d
        .insert(workspaceSettings)
        .values({ key, value, updatedAt: at, updatedBy: by })
        .onConflictDoUpdate({
          target: workspaceSettings.key,
          set: { value, updatedAt: at, updatedBy: by },
          setWhere: ne(workspaceSettings.value, value),
        })
        .returning({ key: workspaceSettings.key });
      return claimed.length > 0;
    },

    async restoreSetting(key, before) {
      if (before === undefined)
        await d.delete(workspaceSettings).where(eq(workspaceSettings.key, key));
      else
        await d
          .update(workspaceSettings)
          .set({ value: before })
          .where(eq(workspaceSettings.key, key));
    },

    settingRecord: (key) =>
      d
        .select({
          value: workspaceSettings.value,
          updatedAt: workspaceSettings.updatedAt,
          updatedBy: workspaceSettings.updatedBy,
        })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.key, key))
        .get(),

    async clearSetting(key) {
      await d.delete(workspaceSettings).where(eq(workspaceSettings.key, key));
    },

    async setSetting(key, value, by) {
      const at = now();
      await d
        .insert(workspaceSettings)
        .values({ key, value, updatedAt: at, updatedBy: by })
        .onConflictDoUpdate({
          target: workspaceSettings.key,
          set: { value, updatedAt: at, updatedBy: by },
        });
    },
  };
}
