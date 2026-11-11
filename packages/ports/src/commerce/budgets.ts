/**
 * Budgets and their spend ledger. `d1BudgetStore` (packages/db) and `InMemoryBudgetStore`
 * (packages/test-kit) implement it, held to one contract.
 *
 * Every read takes a `scope`: one company's (`{ companyId }`) or everything (`{ all: true }`), so a
 * caller bound to a company cannot read another's by forgetting a filter. Lists are keyset paged
 * with the total the filters match. A status moves only by a guarded compare-and-set on the status
 * the caller read.
 *
 * Spend is summed per window from the ledger, never kept as a counter. A commit is one guarded
 * write, keyed by order, step and budget: a strict budget it would take below zero refuses the
 * whole commit, and the same step committing again (a retry) finds its rows and adds none. A
 * reversal is a row of its own, once per commit.
 */
import type {
  Budget,
  BudgetCursor,
  BudgetSpend,
  BudgetStatus,
  BudgetWindow,
} from '@commerceworker/core';

export type BudgetScope = { readonly companyId: string } | { readonly all: true };

export interface BudgetPage<T> {
  readonly rows: T[];
  /** Every row the filters match, not just this page. */
  readonly total: number;
  /** Pass it as `after` for the next page; null on the last. */
  readonly next: BudgetCursor | null;
}

export interface BudgetQuery {
  /** Narrows to one company; a company-scoped read can't widen past its own. */
  readonly companyId?: string;
  readonly teamId?: string;
  readonly status?: BudgetStatus;
  readonly after?: BudgetCursor;
  readonly limit: number;
}

export interface SpendQuery {
  readonly budgetId: string;
  readonly after?: BudgetCursor;
  readonly limit: number;
}

/** A ledger row with whether its order has since been rolled back. */
export interface SpendEntry extends BudgetSpend {
  readonly reversed: boolean;
}

/** What to sum: one budget's spend in the window that opened at `windowStart`. */
export interface SpendWindow {
  readonly budgetId: string;
  readonly windowStart: number;
}

/** One budget an order spends against. */
export interface SpendLine {
  readonly budgetId: string;
  /** In the base currency. */
  readonly amount: number;
  readonly window: BudgetWindow;
}

export interface SpendCommit {
  readonly orderId: string;
  readonly stepKey: string;
  readonly lines: readonly SpendLine[];
  readonly at: number;
}

export interface BudgetStore {
  /** A budget the scope can see. */
  budget(scope: BudgetScope, id: string): Promise<Budget | undefined>;
  /** Budgets by name then id. */
  budgets(scope: BudgetScope, query: BudgetQuery): Promise<BudgetPage<Budget>>;
  /**
   * The active budgets an order from `companyId` is held to: the company's own and those of
   * `teamIds` (the buyer's team and the teams above it), at most `MAX_BUDGETS_PER_ORDER`.
   */
  applicable(scope: BudgetScope, companyId: string, teamIds: readonly string[]): Promise<Budget[]>;
  /**
   * What each window has spent, in one statement: the sum of its ledger rows, commits less
   * reversals. A window with no rows reads 0. `except` names ledger rows left out of the sum: a
   * step that retries asks without the rows it wrote itself, so it judges the budget as the first
   * attempt did.
   */
  spentIn(
    windows: readonly SpendWindow[],
    except?: readonly string[],
  ): Promise<Map<string, number>>;
  /** A budget's ledger, newest first, with whether each commit was since reversed. */
  entries(scope: BudgetScope, query: SpendQuery): Promise<BudgetPage<SpendEntry>>;

  /** Adds a budget, or changes the name, amount and enforcement of the one with this id; false when another company has it. */
  put(budget: Budget): Promise<boolean>;
  /** `from` → `to`, only if the budget is still in `from`. False when it wasn't (or isn't there). */
  transition(
    scope: BudgetScope,
    id: string,
    from: BudgetStatus,
    to: BudgetStatus,
    at: number,
  ): Promise<boolean>;
  /**
   * Records an order's spend against each budget, all or none: refused (false, nothing written)
   * when a strict budget's window has less left than its line. A step that committed already finds
   * its rows and adds none, and says true.
   */
  commit(commit: SpendCommit): Promise<boolean>;
  /**
   * Compensation: reverses the order's commits, each at most once. Returns how many this call
   * reversed.
   */
  reverse(orderId: string, at: number): Promise<number>;
}
