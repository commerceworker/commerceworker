/**
 * The budgets port in memory. The contract in ./budget-store-contract.ts holds it to the same
 * behaviour as the D1 store (packages/db), so use-case tests on it mean what they say about
 * production.
 */
import {
  type Budget,
  type BudgetCursor,
  type BudgetSpend,
  type BudgetStatus,
  budgetReversalId,
  budgetSpendId,
  budgetsFor,
  money,
} from '@commerceworker/core';
import {
  type BudgetPage,
  type BudgetQuery,
  type BudgetScope,
  type BudgetStore,
  type SpendCommit,
  type SpendEntry,
  type SpendQuery,
  type SpendWindow,
  spendKey,
} from '@commerceworker/ports/commerce';

/** What a store holds, as a test seeds it. */
export interface BudgetFixture {
  budgets?: Budget[];
  spend?: BudgetSpend[];
}

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

const sees = (scope: BudgetScope, companyId: string) =>
  'all' in scope || scope.companyId === companyId;

/** `rows` already filtered and in order: the page after `past`, and the total. */
function paged<T>(
  rows: T[],
  key: (r: T) => BudgetCursor,
  past: (k: BudgetCursor) => boolean,
  limit: number,
  cursor: BudgetCursor | undefined,
): BudgetPage<T> {
  const rest = cursor ? rows.filter((r) => past(key(r))) : rows;
  const shown = rest.slice(0, limit);
  return {
    rows: structuredClone(shown),
    total: rows.length,
    next: rest.length > limit ? key(shown.at(-1)!) : null,
  };
}

export class InMemoryBudgetStore implements BudgetStore {
  private readonly rows: Budget[];
  private readonly ledger: BudgetSpend[];

  constructor(fixture: BudgetFixture = {}) {
    const f = structuredClone(fixture);
    this.rows = f.budgets ?? [];
    this.ledger = f.spend ?? [];
  }

  private sum(budgetId: string, windowStart: number, except: readonly string[] = []) {
    return money(
      this.ledger
        .filter(
          (s) => s.budgetId === budgetId && s.windowStart === windowStart && !except.includes(s.id),
        )
        .reduce((n, s) => n + s.amount, 0),
    );
  }

  async budget(scope: BudgetScope, id: string) {
    const b = this.rows.find((x) => x.id === id && sees(scope, x.companyId));
    return b && structuredClone(b);
  }

  async budgets(scope: BudgetScope, q: BudgetQuery) {
    const rows = this.rows
      .filter(
        (b) =>
          sees(scope, b.companyId) &&
          (!q.companyId || b.companyId === q.companyId) &&
          (!q.teamId || b.teamId === q.teamId) &&
          (!q.status || b.status === q.status),
      )
      .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
    const c = q.after;
    return paged(
      rows,
      (b) => ({ key: b.name, id: b.id }),
      (k) => !!c && (cmp(k.key, c.key) > 0 || (k.key === c.key && cmp(k.id, c.id) > 0)),
      q.limit,
      c,
    );
  }

  async applicable(scope: BudgetScope, companyId: string, teamIds: readonly string[]) {
    return structuredClone(
      budgetsFor(
        this.rows.filter((b) => sees(scope, b.companyId)),
        companyId,
        teamIds,
      ),
    );
  }

  async spentIn(windows: readonly SpendWindow[], except: readonly string[] = []) {
    return new Map(
      windows.map((w) => [
        spendKey(w.budgetId, w.windowStart),
        this.sum(w.budgetId, w.windowStart, except),
      ]),
    );
  }

  async entries(scope: BudgetScope, q: SpendQuery) {
    const budget = this.rows.find((b) => b.id === q.budgetId);
    if (!budget || !sees(scope, budget.companyId)) return { rows: [], total: 0, next: null };
    const rows = this.ledger
      .filter((s) => s.budgetId === q.budgetId && s.kind === 'commit')
      .sort((a, b) => cmp(b.at, a.at) || cmp(b.id, a.id))
      .map(
        (s): SpendEntry => ({
          ...s,
          reversed: this.ledger.some((r) => r.id === budgetReversalId(s.id)),
        }),
      );
    const c = q.after;
    return paged(
      rows,
      (e) => ({ key: e.at, id: e.id }),
      (k) => !!c && (cmp(k.key, c.key) < 0 || (k.key === c.key && cmp(k.id, c.id) < 0)),
      q.limit,
      c,
    );
  }

  async put(budget: Budget) {
    const i = this.rows.findIndex((x) => x.id === budget.id);
    const held = this.rows[i];
    if (!held) {
      this.rows.push(structuredClone(budget));
      return true;
    }
    if (held.companyId !== budget.companyId) return false;
    // A budget keeps its company, team, period and anchor: its ledger counts in those.
    Object.assign(held, {
      name: budget.name,
      amount: budget.amount,
      enforcement: budget.enforcement,
      updatedAt: budget.updatedAt,
    });
    return true;
  }

  async transition(
    scope: BudgetScope,
    id: string,
    from: BudgetStatus,
    to: BudgetStatus,
    at: number,
  ) {
    const b = this.rows.find((x) => x.id === id && sees(scope, x.companyId));
    if (!b || b.status !== from) return false;
    b.status = to;
    b.updatedAt = at;
    return true;
  }

  async commit(c: SpendCommit) {
    const lines = c.lines.map((line) => ({
      line,
      id: budgetSpendId(c.orderId, c.stepKey, line.budgetId),
      budget: this.rows.find((b) => b.id === line.budgetId),
    }));
    // All or none, as the one statement the D1 store runs.
    for (const { line, id, budget } of lines) {
      if (!budget) return false;
      const own = this.ledger.some((s) => s.id === id);
      if (
        budget.enforcement === 'strict' &&
        !own &&
        money(budget.amount - this.sum(line.budgetId, line.window.start)) < money(line.amount)
      )
        return false;
    }
    for (const { line, id } of lines)
      if (!this.ledger.some((s) => s.id === id))
        this.ledger.push({
          id,
          budgetId: line.budgetId,
          orderId: c.orderId,
          amount: money(line.amount),
          kind: 'commit',
          windowStart: line.window.start,
          at: c.at,
        });
    return true;
  }

  async reverse(orderId: string, at: number) {
    let n = 0;
    for (const s of [...this.ledger])
      if (
        s.orderId === orderId &&
        s.kind === 'commit' &&
        !this.ledger.some((r) => r.id === budgetReversalId(s.id))
      ) {
        this.ledger.push({
          id: budgetReversalId(s.id),
          budgetId: s.budgetId,
          orderId,
          amount: -s.amount,
          kind: 'reverse',
          windowStart: s.windowStart,
          at,
        });
        n++;
      }
    return n;
  }
}
