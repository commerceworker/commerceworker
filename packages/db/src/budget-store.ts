/**
 * The budgets port (`BudgetStore`, @commerceworker/ports/commerce) on D1: `budgets` and the
 * `budget_spend` ledger. Every read is bound by its scope in the statement itself, so a
 * company-scoped caller can't read another's rows; a status move is one `UPDATE … WHERE id = ? AND
 * status = ?`. Spend is summed from the ledger per window in one statement, never kept as a
 * counter. A commit is one `INSERT … SELECT` that writes every line or none: it refuses when a
 * strict budget in the request has less left than its line, and the primary key (order, step and
 * budget) makes a retry add nothing. A reversal is one insert of the negated rows, once per
 * commit. The contract in @commerceworker/test-kit/commerce holds this and the in-memory store to
 * the same behaviour.
 */
import {
  type Budget,
  type BudgetCursor,
  budgetSpendId,
  MAX_BUDGETS_PER_ORDER,
  money,
} from '@commerceworker/core';
import {
  type BudgetPage,
  type BudgetScope,
  type BudgetStore,
  type SpendEntry,
  spendKey,
} from '@commerceworker/ports/commerce';
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from 'drizzle-orm';
import { createDb } from './index';
import { budgets } from './schema';

/** `column = scope's company`, or nothing for every company. */
const bound = (column: SQLWrapper, scope: BudgetScope): SQL | undefined =>
  'all' in scope ? undefined : eq(column, scope.companyId);

function pageOf<T>(
  rows: T[],
  total: number,
  limit: number,
  key: (r: T) => BudgetCursor,
): BudgetPage<T> {
  const shown = rows.slice(0, limit);
  return { rows: shown, total, next: rows.length > limit ? key(shown.at(-1)!) : null };
}

type BudgetRow = typeof budgets.$inferSelect;
const budgetOf = (r: BudgetRow): Budget => r as Budget;

type EntryRow = {
  id: string;
  budget_id: string;
  order_id: string;
  amount: number;
  kind: 'commit' | 'reverse';
  window_start: number;
  at: number;
  reversed: number;
};

export function d1BudgetStore(d1: D1Database): BudgetStore {
  const d = createDb(d1);

  return {
    async budget(scope, id) {
      const row = await d
        .select()
        .from(budgets)
        .where(and(eq(budgets.id, id), bound(budgets.companyId, scope)))
        .get();
      return row && budgetOf(row);
    },

    async budgets(scope, q) {
      // Naming another company doesn't widen a scope: there is nothing to read.
      if (!('all' in scope) && q.companyId && q.companyId !== scope.companyId)
        return { rows: [], total: 0, next: null };
      const where = and(
        bound(budgets.companyId, scope),
        q.companyId ? eq(budgets.companyId, q.companyId) : undefined,
        q.teamId ? eq(budgets.teamId, q.teamId) : undefined,
        q.status ? eq(budgets.status, q.status) : undefined,
      );
      const after = q.after;
      const [total, rows] = await d.batch([
        d.select({ n: count() }).from(budgets).where(where),
        d
          .select()
          .from(budgets)
          .where(
            and(
              where,
              after
                ? sql`(${budgets.name}, ${budgets.id}) > (${after.key}, ${after.id})`
                : undefined,
            ),
          )
          .orderBy(asc(budgets.name), asc(budgets.id))
          .limit(q.limit + 1),
      ]);
      return pageOf(rows.map(budgetOf), total[0]?.n ?? 0, q.limit, (b) => ({
        key: b.name,
        id: b.id,
      }));
    },

    async applicable(scope, companyId, teamIds) {
      const rows = await d
        .select()
        .from(budgets)
        .where(
          and(
            eq(budgets.companyId, companyId),
            bound(budgets.companyId, scope),
            eq(budgets.status, 'active'),
            teamIds.length
              ? or(isNull(budgets.teamId), inArray(budgets.teamId, [...teamIds]))
              : isNull(budgets.teamId),
          ),
        )
        .orderBy(asc(budgets.name), asc(budgets.id))
        .limit(MAX_BUDGETS_PER_ORDER);
      return rows.map(budgetOf);
    },

    async spentIn(windows, except = []) {
      const out = new Map<string, number>();
      for (const w of windows) out.set(spendKey(w.budgetId, w.windowStart), 0);
      if (!windows.length) return out;
      // The pairs travel as one JSON parameter, so the count of budgets never meets D1's limit.
      const pairs = JSON.stringify(windows.map((w) => [w.budgetId, w.windowStart]));
      const { results } = await d1
        .prepare(
          `SELECT budget_id, window_start, sum(amount) AS spent FROM budget_spend
            WHERE (budget_id, window_start) IN
              (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1))
              AND id NOT IN (SELECT value FROM json_each(?2))
            GROUP BY budget_id, window_start`,
        )
        .bind(pairs, JSON.stringify(except))
        .all<{ budget_id: string; window_start: number; spent: number }>();
      for (const r of results) out.set(spendKey(r.budget_id, r.window_start), money(r.spent));
      return out;
    },

    async entries(scope, q) {
      const scoped = 'all' in scope ? 1 : 0;
      const company = 'all' in scope ? '' : scope.companyId;
      const after = q.after;
      const visible = `s.budget_id = ?1 AND s.kind = 'commit' AND (?2 = 1 OR b.company_id = ?3)`;
      const from = `FROM budget_spend s JOIN budgets b ON b.id = s.budget_id`;
      const [total, rows] = await d1.batch([
        d1
          .prepare(`SELECT count(*) AS n ${from} WHERE ${visible}`)
          .bind(q.budgetId, scoped, company),
        d1
          .prepare(
            `SELECT s.id, s.budget_id, s.order_id, s.amount, s.kind, s.window_start, s.at,
                    EXISTS (SELECT 1 FROM budget_spend r WHERE r.id = 'rev_' || s.id) AS reversed
               ${from} WHERE ${visible}
                AND (?4 IS NULL OR (s.at, s.id) < (?4, ?5))
              ORDER BY s.at DESC, s.id DESC LIMIT ?6`,
          )
          .bind(
            q.budgetId,
            scoped,
            company,
            after ? after.key : null,
            after ? after.id : null,
            q.limit + 1,
          ),
      ]);
      const entries = (rows!.results as EntryRow[]).map(
        (r): SpendEntry => ({
          id: r.id,
          budgetId: r.budget_id,
          orderId: r.order_id,
          amount: r.amount,
          kind: r.kind,
          windowStart: r.window_start,
          at: r.at,
          reversed: !!r.reversed,
        }),
      );
      return pageOf(
        entries,
        (total!.results[0] as { n: number } | undefined)?.n ?? 0,
        q.limit,
        (e) => ({
          key: e.at,
          id: e.id,
        }),
      );
    },

    async put(b) {
      const res = await d
        .insert(budgets)
        .values(b)
        .onConflictDoUpdate({
          target: budgets.id,
          // A budget keeps its company, team, period and anchor: its ledger counts in those.
          set: {
            name: b.name,
            amount: b.amount,
            enforcement: b.enforcement,
            updatedAt: b.updatedAt,
          },
          setWhere: eq(budgets.companyId, b.companyId),
        })
        .returning({ id: budgets.id });
      return res.length > 0;
    },

    async transition(scope, id, from, to, at) {
      const res = await d
        .update(budgets)
        .set({ status: to, updatedAt: at })
        .where(and(eq(budgets.id, id), eq(budgets.status, from), bound(budgets.companyId, scope)))
        .returning({ id: budgets.id });
      return res.length > 0;
    },

    async commit(c) {
      if (!c.lines.length) return true;
      const rows = c.lines.map((l) => ({
        id: budgetSpendId(c.orderId, c.stepKey, l.budgetId),
        line: l,
      }));
      const lines = JSON.stringify(
        rows.map(({ id, line }) => [id, line.budgetId, money(line.amount), line.window.start]),
      );
      // One statement, so every line lands or none does. A strict budget refuses when what its
      // window has spent leaves less than the line, unless this step already committed that line
      // (a retry, whose own row is part of what is spent).
      const [, found] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO budget_spend (id, budget_id, order_id, amount, kind, window_start, at)
             SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), ?2,
                    json_extract(j.value, '$[2]'), 'commit', json_extract(j.value, '$[3]'), ?3
               FROM json_each(?1) j
               JOIN budgets b ON b.id = json_extract(j.value, '$[1]')
              WHERE NOT EXISTS (
                SELECT 1 FROM json_each(?1) k
                  JOIN budgets sb ON sb.id = json_extract(k.value, '$[1]')
                 WHERE sb.enforcement = 'strict'
                   AND round(sb.amount - coalesce((SELECT sum(s.amount) FROM budget_spend s
                         WHERE s.budget_id = sb.id AND s.window_start = json_extract(k.value, '$[3]')), 0), 2)
                       < round(json_extract(k.value, '$[2]'), 2)
                   AND NOT EXISTS (SELECT 1 FROM budget_spend own WHERE own.id = json_extract(k.value, '$[0]')))
             ON CONFLICT (id) DO NOTHING`,
          )
          .bind(lines, c.orderId, c.at),
        d1
          .prepare(
            `SELECT count(*) AS n FROM budget_spend WHERE id IN (SELECT json_extract(value, '$[0]') FROM json_each(?1))`,
          )
          .bind(lines),
      ]);
      return (found!.results[0] as { n: number } | undefined)?.n === rows.length;
    },

    async reverse(orderId, at) {
      const { results } = await d1
        .prepare(
          `INSERT INTO budget_spend (id, budget_id, order_id, amount, kind, window_start, at)
           -- rev_ and the commit id: budgetReversalId in core.
           SELECT 'rev_' || c.id, c.budget_id, c.order_id, -c.amount, 'reverse', c.window_start, ?2
             FROM budget_spend c WHERE c.order_id = ?1 AND c.kind = 'commit'
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
        )
        .bind(orderId, at)
        .all<{ id: string }>();
      return results.length;
    },
  };
}
