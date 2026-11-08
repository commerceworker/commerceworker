/**
 * The SCIM directory port over D1: `users` (the people SCIM manages), `scim_groups` and
 * `scim_group_members`. Moved here from the web app's SCIM endpoint. A page is one batch (its
 * count and its rows); an email change and a group's deletion each write in one batch, so neither
 * stops halfway. The contract in @commerceworker/test-kit/commerce holds this and the in-memory
 * store to the same behaviour.
 */
import type { Role } from '@commerceworker/core';
import type { ScimDirectory, ScimFilter } from '@commerceworker/ports/commerce';
import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import { createDb } from './index';
import { apiTokens, scimGroupMembers, scimGroups, users } from './schema';

const personCols = {
  id: users.id,
  email: users.email,
  name: users.name,
  disabledAt: users.disabledAt,
  scimExternalId: users.scimExternalId,
  createdAt: users.createdAt,
};

const personWhere = (f: ScimFilter | null) =>
  !f
    ? undefined
    : f.attr === 'userName'
      ? eq(users.email, f.value.toLowerCase())
      : f.attr === 'externalId'
        ? eq(users.scimExternalId, f.value)
        : f.attr === 'id'
          ? eq(users.id, f.value)
          : eq(users.name, f.value);

const groupWhere = (f: ScimFilter | null) =>
  !f
    ? undefined
    : f.attr === 'externalId'
      ? eq(scimGroups.externalId, f.value)
      : f.attr === 'id'
        ? eq(scimGroups.id, f.value)
        : eq(scimGroups.displayName, f.value);

/** Ids in runs that fit one statement's 100 bound parameters, with room for the rest. */
function chunks<T>(ids: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

export function d1ScimDirectory(d1: D1Database): ScimDirectory {
  const d = createDb(d1);
  return {
    async people(f, offset, limit) {
      const where = personWhere(f);
      const total = d.select({ n: count() }).from(users).where(where);
      if (!limit) return { total: (await total.get())?.n ?? 0, rows: [] };
      const [n, rows] = await d.batch([
        total,
        d
          .select(personCols)
          .from(users)
          .where(where)
          .orderBy(users.createdAt)
          .limit(limit)
          .offset(offset),
      ]);
      return { total: n[0]?.n ?? 0, rows };
    },
    person: (id) => d.select(personCols).from(users).where(eq(users.id, id)).get(),
    personByEmail: (email) => d.select(personCols).from(users).where(eq(users.email, email)).get(),
    async addPerson(p) {
      await d.insert(users).values({ ...p, role: 'viewer' });
    },
    async updatePerson(id, set) {
      const update = d.update(users).set(set).where(eq(users.id, id));
      if (!set.email) return void (await update);
      // Tokens made before their maker's id was kept are matched by the address they were made
      // under: tie them to the person before that address changes.
      await d.batch([
        d
          .update(apiTokens)
          .set({ createdById: id })
          .where(
            and(
              isNull(apiTokens.createdById),
              eq(
                apiTokens.createdBy,
                d.select({ email: users.email }).from(users).where(eq(users.id, id)),
              ),
            ),
          ),
        update,
      ]);
    },
    async signsInWith(id) {
      const r = await d
        .select({ hash: users.passwordHash, sub: users.externalSub })
        .from(users)
        .where(eq(users.id, id))
        .get();
      return { password: !!r?.hash, linked: !!r?.sub };
    },
    async role(id) {
      const r = await d.select({ role: users.role }).from(users).where(eq(users.id, id)).get();
      return (r?.role ?? 'viewer') as Role;
    },
    async setRole(id, role) {
      await d.update(users).set({ role }).where(eq(users.id, id));
    },
    async otherAdmins(exceptId) {
      const r = await d
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, exceptId)))
        .get();
      return r?.n ?? 0;
    },
    async setDisabled(id, at) {
      await d.update(users).set({ disabledAt: at }).where(eq(users.id, id));
    },

    async groups(f, offset, limit) {
      const where = groupWhere(f);
      const total = d.select({ n: count() }).from(scimGroups).where(where);
      if (!limit) return { total: (await total.get())?.n ?? 0, rows: [] };
      const [n, rows] = await d.batch([
        total,
        d
          .select()
          .from(scimGroups)
          .where(where)
          .orderBy(scimGroups.createdAt)
          .limit(limit)
          .offset(offset),
      ]);
      return { total: n[0]?.n ?? 0, rows };
    },
    group: (id) => d.select().from(scimGroups).where(eq(scimGroups.id, id)).get(),
    async addGroup(g) {
      await d.insert(scimGroups).values(g);
    },
    async updateGroup(id, set) {
      await d.update(scimGroups).set(set).where(eq(scimGroups.id, id));
    },
    async deleteGroup(id) {
      await d.batch([
        d.delete(scimGroupMembers).where(eq(scimGroupMembers.groupId, id)),
        d.delete(scimGroups).where(eq(scimGroups.id, id)),
      ]);
    },
    async members(groupId) {
      const rows = await d
        .select({ id: scimGroupMembers.userId })
        .from(scimGroupMembers)
        .where(eq(scimGroupMembers.groupId, groupId));
      return rows.map((r) => r.id);
    },
    async existing(ids) {
      if (!ids.length) return [];
      const found = new Set<string>();
      for (const run of chunks([...new Set(ids)], 90)) {
        const rows = await d.select({ id: users.id }).from(users).where(inArray(users.id, run));
        for (const r of rows) found.add(r.id);
      }
      return ids.filter((id) => found.has(id));
    },
    async addMembers(groupId, ids) {
      // Two parameters a row.
      for (const run of chunks([...new Set(ids)], 40))
        await d
          .insert(scimGroupMembers)
          .values(run.map((userId) => ({ groupId, userId })))
          .onConflictDoNothing();
    },
    async removeMembers(groupId, ids) {
      for (const run of chunks(ids, 90))
        await d
          .delete(scimGroupMembers)
          .where(and(eq(scimGroupMembers.groupId, groupId), inArray(scimGroupMembers.userId, run)));
    },
    async leaveGroups(userId) {
      await d.delete(scimGroupMembers).where(eq(scimGroupMembers.userId, userId));
    },
    async groupsOf(userId) {
      const rows = await d
        .select({ id: scimGroupMembers.groupId })
        .from(scimGroupMembers)
        .where(eq(scimGroupMembers.userId, userId));
      return rows.map((r) => r.id);
    },
    groupSizes: () =>
      d
        .select({
          id: scimGroups.id,
          displayName: scimGroups.displayName,
          members: count(scimGroupMembers.userId),
        })
        .from(scimGroups)
        .leftJoin(scimGroupMembers, eq(scimGroupMembers.groupId, scimGroups.id))
        .groupBy(scimGroups.id)
        .orderBy(scimGroups.displayName),
  };
}
