import type { AdminTeam } from '@commerceworker/ports';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { authDbOf } from './auth';
import { users } from './auth-schema';

export function createAdminTeam(d1: D1Database): AdminTeam {
  const db = authDbOf(d1);
  const otherAdmin = (id: string) => sql`exists (select 1 from ${users} as other
    where other.role = 'admin' and other.disabled_at is null and other.id <> ${id})`;
  return {
    people: () =>
      db
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
    async hasOtherAdmin(id) {
      return !!(await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, id)))
        .get());
    },
    async setRole(id, role) {
      const rows = await db
        .update(users)
        .set({ role })
        .where(and(eq(users.id, id), role === 'admin' ? undefined : otherAdmin(id)))
        .returning({ id: users.id });
      return rows.length > 0;
    },
    async setDisabled(id, at) {
      const rows = await db
        .update(users)
        .set({ disabledAt: at })
        .where(and(eq(users.id, id), at === null ? undefined : otherAdmin(id)))
        .returning({ id: users.id });
      return rows.length > 0;
    },
    admins: (limit) =>
      db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
        .orderBy(users.name)
        .limit(limit),
  };
}
