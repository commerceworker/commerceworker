/**
 * `@commerceworker/store/auth`: the human sign-in tables (auth-schema.ts) and the small helpers the
 * admin web app needs around them. Depends on drizzle alone, so the web Worker can import it
 * without the content store.
 */

import type { PeopleDirectory } from '@commerceworker/ports';
import { and, desc, eq, gt, isNotNull, isNull, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import * as authSchema from './auth-schema';
import { adminAudit, sessions, users } from './auth-schema';

export * from './auth-schema';
export { authSchema };

/** A drizzle D1 database over the auth tables (apps/studio builds one per D1 binding). */
export type AuthDb = DrizzleD1Database<typeof authSchema>;

/** The auth tables over a D1 binding, for a Worker that reads them without the web app's wiring. */
export const authDbOf = (d1: D1Database): AuthDb => drizzle(d1, { schema: authSchema });

/** `text` with LIKE's wildcards and the escape character escaped, to match literally. */
const literal = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** `column LIKE 'text%'`, with `text` matched literally. */
export const startsWith = (column: SQLWrapper, text: string): SQL =>
  sql`${column} like ${`${literal(text)}%`} escape '\\'`;

// ── Appending to the admin audit log's hash chain ──
// Two writers can read the same head; the unique `seq` refuses the second, which waits a moment,
// reads the new head and tries again.

export type AuditHead = { seq: number; hash: string };
type Sealed = typeof adminAudit.$inferInsert & { seq: number; hash: string };

const ATTEMPTS = 20;

/** The newest sealed event, or null before the first. */
export async function auditHead(db: AuthDb): Promise<AuditHead | null> {
  const head = await db
    .select({ seq: adminAudit.seq, hash: adminAudit.hash })
    .from(adminAudit)
    .where(isNotNull(adminAudit.seq))
    .orderBy(desc(adminAudit.seq))
    .limit(1)
    .get();
  return head?.seq && head.hash ? { seq: head.seq, hash: head.hash } : null;
}

/** Inserts the event `seal` makes for the current head (`sealAuditRow` in the web app). */
export async function appendAudit<Row extends Sealed>(
  db: AuthDb,
  seal: (head: AuditHead | null) => Promise<Row>,
): Promise<Row> {
  for (let attempt = 1; ; attempt++) {
    const row = await seal(await auditHead(db));
    try {
      await db.insert(adminAudit).values(row);
      return row;
    } catch (err) {
      // Drizzle wraps D1's error; the constraint is named in its cause.
      const text = `${err} ${(err as { cause?: unknown }).cause ?? ''}`;
      const lost = /UNIQUE constraint failed: admin_audit\.seq/.test(text);
      if (!lost || attempt === ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt));
    }
  }
}

// ── A person as they are now, for what keeps acting after their request ──

/** Someone with an enabled account, and when their session was last used (if one was named). */
export type PersonNow = {
  id: string;
  email: string;
  name: string;
  role: string;
  /** The named session's last activity (or its start), ms; absent when no session was named. */
  seenAt?: number;
};

/**
 * The person `sub` as they are now: null when they don't exist or are disabled, or, when `sid`
 * names a session, once that session has been deleted (signed out, a password reset) or has
 * expired, or isn't theirs. Read-only: it never counts as activity, so idleness is the caller's to
 * judge from `seenAt` (`sessionIdleMs` in `@commerceworker/security/roles`).
 */
export async function personNow(
  db: AuthDb,
  who: { sub: string; sid?: string },
  now = Date.now(),
): Promise<PersonNow | null> {
  const person = { id: users.id, email: users.email, name: users.name, role: users.role };
  if (!who.sid) {
    const row = await db
      .select(person)
      .from(users)
      .where(and(eq(users.id, who.sub), isNull(users.disabledAt)))
      .get();
    return row ?? null;
  }
  const row = await db
    .select({
      ...person,
      seenAt: sql<number>`coalesce(${sessions.lastSeenAt}, ${sessions.createdAt})`,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, who.sid),
        eq(sessions.userId, who.sub),
        gt(sessions.expiresAt, now),
        isNull(users.disabledAt),
      ),
    )
    .get();
  return row ?? null;
}

/** Whether anyone has an account yet: before then, local development runs open (as `local`). */
export async function anyPeople(db: AuthDb): Promise<boolean> {
  return Boolean(await db.select({ id: users.id }).from(users).limit(1).get());
}

/** The {@link PeopleDirectory} port over a D1 binding's auth tables, bound in `wireEdge`. */
export function createPeopleDirectory(d1: D1Database): PeopleDirectory {
  const db = authDbOf(d1);
  return {
    personNow: (who, now) => personNow(db, who, now),
    anyPeople: () => anyPeople(db),
  };
}
