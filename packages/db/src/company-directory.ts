/**
 * The companies port (`CompanyDirectory`, @commerceworker/ports/commerce) on D1: `companies`,
 * `company_teams` and `company_members`, and the `customers` rows they hang off. Every read is
 * bound by its scope in the statement itself, so a company-scoped caller can't read another's
 * rows; every status move is one `UPDATE … WHERE id = ? AND status = ?`, so of two racing moves
 * from the same state one wins. Lists are keyset paged, a page and its total in one round trip.
 * Member writes are chunked under D1's 100 bound parameters per statement. The contract in
 * @commerceworker/test-kit/commerce holds this and the in-memory store to the same behaviour.
 */
import type { CompanyCursor, CompanyMember, CompanyTeam } from '@commerceworker/core';
import type {
  CompanyDirectory,
  CompanyPage,
  CompanyRecord,
  CompanyScope,
  MemberWrite,
} from '@commerceworker/ports/commerce';
import { and, asc, count, eq, or, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { createDb } from './index';
import { contains } from './match';
import { companies, companyMembers, companyTeams, customers } from './schema';

/** D1 binds at most 100 parameters a statement; a member row binds this many. */
const MEMBER_PARAMS = 10;
const MEMBER_CHUNK = Math.floor(100 / MEMBER_PARAMS) - 1;

const companyColumns = {
  customerId: companies.customerId,
  status: companies.status,
  legalName: companies.legalName,
  taxId: companies.taxId,
  parentCompanyId: companies.parentCompanyId,
  createdAt: companies.createdAt,
  updatedAt: companies.updatedAt,
  name: customers.name,
  email: customers.email,
  tier: customers.tier,
};

type MemberRow = typeof companyMembers.$inferSelect;
const memberOf = (r: MemberRow): CompanyMember => r as CompanyMember;

/** `column = scope's company`, or nothing for every company. */
const bound = (column: SQLWrapper, scope: CompanyScope): SQL | undefined =>
  'all' in scope ? undefined : eq(column, scope.companyId);

/** Rows after the cursor in (name, id) order; D1's SQLite compares row values. */
const keyset = (name: SQLWrapper, id: SQLWrapper, c?: CompanyCursor) =>
  c ? sql`(${name}, ${id}) > (${c.name}, ${c.id})` : undefined;

function pageOf<T>(
  rows: T[],
  total: number,
  limit: number,
  key: (r: T) => CompanyCursor,
): CompanyPage<T> {
  const shown = rows.slice(0, limit);
  return { rows: shown, total, next: rows.length > limit ? key(shown.at(-1)!) : null };
}

export function d1CompanyDirectory(d1: D1Database): CompanyDirectory {
  const d = createDb(d1);
  const record = () =>
    d
      .select(companyColumns)
      .from(companies)
      .innerJoin(customers, eq(customers.id, companies.customerId));

  return {
    async customer(scope, id) {
      return d
        .select()
        .from(customers)
        .where(and(eq(customers.id, id), bound(customers.id, scope)))
        .get();
    },

    async customerByEmail(scope, email) {
      return d
        .select()
        .from(customers)
        .where(
          and(sql`lower(${customers.email}) = ${email.toLowerCase()}`, bound(customers.id, scope)),
        )
        .orderBy(asc(customers.id))
        .limit(1)
        .get();
    },

    async companies(scope, q) {
      const needle = q.search?.trim();
      const where = and(
        bound(companies.customerId, scope),
        q.status ? eq(companies.status, q.status) : undefined,
        needle
          ? or(
              contains(customers.name, needle),
              contains(companies.legalName, needle),
              contains(companies.customerId, needle),
            )
          : undefined,
      );
      const [total, rows] = await d.batch([
        d
          .select({ n: count() })
          .from(companies)
          .innerJoin(customers, eq(customers.id, companies.customerId))
          .where(where),
        record()
          .where(and(where, keyset(customers.name, companies.customerId, q.after)))
          .orderBy(asc(customers.name), asc(companies.customerId))
          .limit(q.limit + 1),
      ]);
      return pageOf(rows as CompanyRecord[], total[0]?.n ?? 0, q.limit, (c) => ({
        name: c.name,
        id: c.customerId,
      }));
    },

    async company(scope, customerId) {
      return (await record()
        .where(and(eq(companies.customerId, customerId), bound(companies.customerId, scope)))
        .get()) as CompanyRecord | undefined;
    },

    async ancestry(scope, customerId) {
      // A scoped caller sees one company, and so none above it.
      if (!('all' in scope)) return [];
      const up = await d1
        .prepare(
          `WITH RECURSIVE up(id, parent, depth) AS (
             SELECT customer_id, parent_company_id, 0 FROM companies WHERE customer_id = ?
             UNION ALL
             SELECT c.customer_id, c.parent_company_id, up.depth + 1
               FROM companies c JOIN up ON c.customer_id = up.parent WHERE up.depth < 10)
           SELECT id FROM up WHERE depth > 0 ORDER BY depth`,
        )
        .bind(customerId)
        .all<{ id: string }>();
      return up.results.map((r) => r.id);
    },

    async teams(scope, companyId) {
      return d
        .select()
        .from(companyTeams)
        .where(and(eq(companyTeams.companyId, companyId), bound(companyTeams.companyId, scope)))
        .orderBy(asc(companyTeams.path));
    },

    async members(scope, q) {
      // Naming another company doesn't widen a scope: there is nothing to read.
      if (!('all' in scope) && q.companyId && q.companyId !== scope.companyId)
        return { rows: [], total: 0, next: null };
      const where = and(
        bound(companyMembers.companyId, scope),
        q.companyId ? eq(companyMembers.companyId, q.companyId) : undefined,
        q.status ? eq(companyMembers.status, q.status) : undefined,
        q.role ? eq(companyMembers.role, q.role) : undefined,
        q.teamId ? eq(companyMembers.teamId, q.teamId) : undefined,
      );
      const [total, rows] = await d.batch([
        d.select({ n: count() }).from(companyMembers).where(where),
        d
          .select()
          .from(companyMembers)
          .where(and(where, keyset(companyMembers.name, companyMembers.id, q.after)))
          .orderBy(asc(companyMembers.name), asc(companyMembers.id))
          .limit(q.limit + 1),
      ]);
      return pageOf(rows.map(memberOf), total[0]?.n ?? 0, q.limit, (m) => ({
        name: m.name,
        id: m.id,
      }));
    },

    async member(scope, companyId, memberId) {
      const row = await d
        .select()
        .from(companyMembers)
        .where(
          and(
            eq(companyMembers.id, memberId),
            eq(companyMembers.companyId, companyId),
            bound(companyMembers.companyId, scope),
          ),
        )
        .get();
      return row && memberOf(row);
    },

    async membersByEmail(scope, companyId, emails) {
      const out: CompanyMember[] = [];
      // One bound parameter an email, and the company: stay under the limit.
      for (let i = 0; i < emails.length; i += 90) {
        const chunk = emails.slice(i, i + 90).map((e) => e.toLowerCase());
        const rows = await d
          .select()
          .from(companyMembers)
          .where(
            and(
              eq(companyMembers.companyId, companyId),
              bound(companyMembers.companyId, scope),
              sql`lower(${companyMembers.email}) in (${sql.join(chunk, sql`, `)})`,
            ),
          );
        out.push(...rows.map(memberOf));
      }
      return out;
    },

    async access(scope, customerId, buyerId) {
      const company = record().where(
        and(eq(companies.customerId, customerId), bound(companies.customerId, scope)),
      );
      if (!buyerId) {
        const [c] = await company.limit(1);
        return c ? { company: c as CompanyRecord } : {};
      }
      const [c, m] = await d.batch([
        company.limit(1),
        d
          .select()
          .from(companyMembers)
          .where(
            and(
              eq(companyMembers.id, buyerId),
              eq(companyMembers.companyId, customerId),
              bound(companyMembers.companyId, scope),
            ),
          )
          .limit(1),
      ]);
      return {
        ...(c[0] ? { company: c[0] as CompanyRecord } : {}),
        ...(m[0] ? { buyer: memberOf(m[0]) } : {}),
      };
    },

    async createCustomer(customer, company) {
      const insertCustomer = d
        .insert(customers)
        .values({ ...customer, creditLimit: 0, balance: 0 })
        .onConflictDoNothing()
        .returning({ id: customers.id });
      const [added] = company
        ? await d.batch([insertCustomer, d.insert(companies).values(company).onConflictDoNothing()])
        : await d.batch([insertCustomer]);
      return added.length > 0;
    },

    async updateCustomer(id, patch) {
      const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (!Object.keys(set).length)
        return !!(await d
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, id))
          .get());
      const res = await d
        .update(customers)
        .set(set)
        .where(eq(customers.id, id))
        .returning({ id: customers.id });
      return res.length > 0;
    },

    async createCompany(company) {
      const res = await d
        .insert(companies)
        .values(company)
        .onConflictDoNothing()
        .returning({ id: companies.customerId });
      return res.length > 0;
    },

    async transitionCompany(scope, customerId, from, to, at) {
      const res = await d
        .update(companies)
        .set({ status: to, updatedAt: at })
        .where(
          and(
            eq(companies.customerId, customerId),
            eq(companies.status, from),
            bound(companies.customerId, scope),
          ),
        )
        .returning({ id: companies.customerId });
      return res.length > 0;
    },

    async upsertMembers(companyId, members: readonly MemberWrite[], at) {
      const statements: D1PreparedStatement[] = [];
      for (let i = 0; i < members.length; i += MEMBER_CHUNK) {
        const chunk = members.slice(i, i + MEMBER_CHUNK);
        const values = chunk.map(() => `(${Array(MEMBER_PARAMS).fill('?').join(', ')})`).join(', ');
        statements.push(
          d1
            .prepare(
              `INSERT INTO company_members
                 (id, company_id, name, email, role, team_id, status, order_limit, created_at, updated_at)
               VALUES ${values}
               ON CONFLICT (company_id, lower(email)) WHERE status <> 'removed'
               DO UPDATE SET name = excluded.name, role = excluded.role,
                 team_id = excluded.team_id, order_limit = excluded.order_limit,
                 updated_at = excluded.updated_at`,
            )
            .bind(
              ...chunk.flatMap((m) => [
                m.id,
                companyId,
                m.name,
                m.email.toLowerCase(),
                m.role,
                m.teamId,
                m.status,
                m.orderLimit,
                at,
                at,
              ]),
            ),
        );
      }
      if (statements.length) await d1.batch(statements);
    },

    async transitionMember(scope, companyId, memberId, from, to, at) {
      const res = await d
        .update(companyMembers)
        .set({ status: to, updatedAt: at })
        .where(
          and(
            eq(companyMembers.id, memberId),
            eq(companyMembers.companyId, companyId),
            eq(companyMembers.status, from),
            bound(companyMembers.companyId, scope),
          ),
        )
        .returning({ id: companyMembers.id });
      return res.length > 0;
    },

    async putTeam(team: CompanyTeam) {
      // Descendants first, while the team still holds its old path; then the team itself. One batch.
      await d1.batch([
        d1
          .prepare(
            `UPDATE company_teams
                SET path = ?1 || substr(path, length((SELECT path FROM company_teams WHERE id = ?2)) + 1)
              WHERE company_id = ?3 AND id <> ?2
                AND substr(path, 1, length((SELECT path FROM company_teams WHERE id = ?2)))
                  = (SELECT path FROM company_teams WHERE id = ?2)`,
          )
          .bind(team.path, team.id, team.companyId),
        d1
          .prepare(
            `INSERT INTO company_teams (id, company_id, parent_id, name, path) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, path = excluded.path`,
          )
          .bind(team.id, team.companyId, team.parentId, team.name, team.path),
      ]);
    },
  };
}
