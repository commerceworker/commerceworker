/**
 * Budgets: what a company, or one of its teams, may spend in a period. The rules here, with no
 * storage, are the two lifecycles, the calendar windows a budget counts in (`budgetWindow`), which
 * budgets an order is held to (`budgetsFor`) and the multi-budget check (`budgetChecks`).
 * `docs/b2b.md` is the plan; D5 (each budget is `strict` or `advisory`, advisory unless chosen) and
 * D8 (amounts in the base currency) are the defaults this is built on.
 *
 * Spend is never a counter. It is a ledger of rows keyed by order, step and budget, summed per
 * window, so a window that has passed simply stops counting and a reversed order nets to nothing
 * (v1 kept a counter that never reset and could not be reversed).
 */
import { z } from 'zod';
import { defineLifecycle } from '../lifecycle';
import { money, toBase } from '../logic';
import { advancePeriod } from '../subscriptions';

export const BUDGET_PERIODS = ['weekly', 'monthly', 'quarterly', 'yearly', 'one_time'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  one_time: 'One time',
};

/** D5: a strict budget refuses an order that would go over it; an advisory one only warns. */
export const BUDGET_ENFORCEMENTS = ['strict', 'advisory'] as const;
export type BudgetEnforcement = (typeof BUDGET_ENFORCEMENTS)[number];
export const DEFAULT_BUDGET_ENFORCEMENT: BudgetEnforcement = 'advisory';

export const BUDGET_ENFORCEMENT_LABELS: Record<BudgetEnforcement, string> = {
  strict: 'Strict',
  advisory: 'Advisory',
};

export const BUDGET_STATUSES = ['active', 'paused', 'archived'] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

/** A budget is paused and resumed freely; archiving it is final, and keeps its spend on record. */
export const BUDGET_LIFECYCLE = defineLifecycle<BudgetStatus>({
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [],
});

export const BUDGET_STATUS_LABELS: Record<BudgetStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

export const SPEND_KINDS = ['commit', 'reverse'] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

export const SPEND_STATUSES = ['committed', 'reversed'] as const;
export type SpendStatus = (typeof SPEND_STATUSES)[number];

/**
 * A committed spend stays committed until its order is rolled back, then it is reversed for good.
 * The ledger never edits a row: a reversal is a row of its own, and a spend reads as reversed once
 * that row exists.
 */
export const SPEND_LIFECYCLE = defineLifecycle<SpendStatus>({
  committed: ['reversed'],
  reversed: [],
});

/** Caps that keep a company's budgets, an order's check and a page bounded. */
export const MAX_COMPANY_BUDGETS = 100;
export const MAX_BUDGETS_PER_ORDER = 50;
export const BUDGET_PAGE = { default: 25, max: 100 } as const;
export const SPEND_PAGE = { default: 20, max: 100 } as const;

export interface Budget {
  id: string;
  /** The business customer's id: a budget belongs to its company. */
  companyId: string;
  /** A team of the company, which also covers the teams under it; null for the whole company. */
  teamId: string | null;
  name: string;
  /** What may be spent in a window, in the base currency. */
  amount: number;
  period: BudgetPeriod;
  /** When it starts counting (ms, UTC): a one-time budget's window opens here. */
  anchor: number;
  enforcement: BudgetEnforcement;
  status: BudgetStatus;
  createdAt: number;
  updatedAt: number;
}

/** One ledger row: a commit, or the reversal of one (the negated amount, in the same window). */
export interface BudgetSpend {
  id: string;
  budgetId: string;
  orderId: string;
  amount: number;
  kind: SpendKind;
  windowStart: number;
  at: number;
}

/** A window a budget counts in: `end` is exclusive, null for a one-time budget that never closes. */
export interface BudgetWindow {
  start: number;
  end: number | null;
}

const MONTHS_PER: Partial<Record<BudgetPeriod, number>> = { monthly: 1, quarterly: 3 };

/**
 * The window `period` counts `now` in, or null before the budget's `anchor` (not yet in force).
 * Windows are UTC calendar periods whatever the anchor: a week from Monday, a month, a quarter
 * from January, April, July or October, a year. A one-time budget is one window from its anchor.
 */
export function budgetWindow(
  period: BudgetPeriod,
  anchor: number,
  now: number,
): BudgetWindow | null {
  if (now < anchor) return null;
  if (period === 'one_time') return { start: anchor, end: null };
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let start: Date;
  switch (period) {
    case 'weekly':
      // Monday is 1; Sunday (0) belongs to the week that began six days before.
      start = new Date(day - ((d.getUTCDay() + 6) % 7) * 86_400_000);
      break;
    case 'yearly':
      start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      break;
    default: {
      const months = MONTHS_PER[period] ?? 1;
      start = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (d.getUTCMonth() % months), 1),
      );
    }
  }
  const end =
    period === 'weekly'
      ? advancePeriod(start, 'week', 1)
      : period === 'yearly'
        ? advancePeriod(start, 'year', 1)
        : advancePeriod(start, 'month', MONTHS_PER[period] ?? 1);
  return { start: start.getTime(), end: end.getTime() };
}

/** The ids on a team's path, root first, ending with the team itself: the teams whose budgets cover it. */
export const budgetTeamIds = (path: string | null | undefined): string[] =>
  path ? path.split('/').filter(Boolean) : [];

/**
 * The active budgets an order is held to: the company's own (no team) and those of the buyer's
 * team and the teams above it, in name order, at most `MAX_BUDGETS_PER_ORDER`.
 */
export function budgetsFor(
  budgets: readonly Budget[],
  company: string,
  teamIds: readonly string[],
): Budget[] {
  return budgets
    .filter(
      (b) =>
        b.companyId === company &&
        b.status === 'active' &&
        (b.teamId === null || teamIds.includes(b.teamId)),
    )
    .sort((a, b) => (a.name === b.name ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name)))
    .slice(0, MAX_BUDGETS_PER_ORDER);
}

/** The id a commit gets: `bsp_<orderId>_<stepKey>_<budgetId>`, anything but word characters and `-` as `_`. */
export const budgetSpendId = (orderId: string, stepKey: string, budgetId: string) =>
  `bsp_${orderId}_${stepKey}_${budgetId}`.replace(/[^\w-]/g, '_');

/** The id a commit's reversal gets. */
export const budgetReversalId = (commitId: string) => `rev_${commitId}`;

/** What an order claims of a budget: its total in the base currency. */
export const budgetSpendAmount = (order: { total: number; baseTotal?: number; fxRate?: number }) =>
  money(order.baseTotal ?? toBase(order.total, order.fxRate));

/** A budget with the window it counts `now` in and what that window has spent. */
export interface BudgetUse {
  budget: Budget;
  window: BudgetWindow;
  spent: number;
}

/**
 * The budgets in force at `now`, each with its window: one before its anchor, or not active, isn't.
 */
export function budgetWindows(
  budgets: readonly Budget[],
  now: number,
): { budget: Budget; window: BudgetWindow }[] {
  return budgets.flatMap((budget) => {
    const window =
      budget.status === 'active' ? budgetWindow(budget.period, budget.anchor, now) : null;
    return window ? [{ budget, window }] : [];
  });
}

/** One budget's answer for an order. */
export interface BudgetCheck {
  budgetId: string;
  name: string;
  teamId: string | null;
  period: BudgetPeriod;
  enforcement: BudgetEnforcement;
  amount: number;
  /** What the window has spent before this order. */
  spent: number;
  /** What the budget has left after this order; negative when it goes over. */
  remaining: number;
  exceeded: boolean;
  /** Set for an advisory budget the order goes over: it passes, with this to say so. */
  warning: string | null;
  windowStart: number;
  windowEnd: number | null;
}

/**
 * An order's total, in the base currency, against each budget it is held to. A strict budget it
 * would take below zero is exceeded and the order isn't `within`; an advisory one is exceeded
 * too but passes with a warning. Each budget stands alone: the order is judged against the whole
 * of every budget, not a share.
 */
export function budgetChecks(
  total: number,
  uses: readonly BudgetUse[],
): { within: boolean; checks: BudgetCheck[] } {
  const checks = uses.map(({ budget: b, window, spent }): BudgetCheck => {
    const left = money(b.amount - spent);
    const exceeded = money(total) > left;
    return {
      budgetId: b.id,
      name: b.name,
      teamId: b.teamId,
      period: b.period,
      enforcement: b.enforcement,
      amount: b.amount,
      spent: money(spent),
      remaining: money(left - total),
      exceeded,
      warning:
        exceeded && b.enforcement === 'advisory'
          ? `Over the ${b.name} budget by ${money(total - left)} (advisory, so the order passes)`
          : null,
      windowStart: window.start,
      windowEnd: window.end,
    };
  });
  return { within: !checks.some((c) => c.exceeded && c.enforcement === 'strict'), checks };
}

const id = z.string().min(1).max(100);

/** A budget as a caller writes it: new, or the same `budgetId` again to change it. */
export const budgetInput = z.object({
  companyId: id.describe('The business customer’s id'),
  budgetId: id.optional().describe('Leave out to add a budget; give one to change it'),
  name: z.string().trim().min(1).max(80),
  amount: z.number().positive().max(1e12).describe('What may be spent in a window, base currency'),
  period: z
    .enum(BUDGET_PERIODS)
    .optional()
    .describe('Required for a new budget; it can’t be changed later'),
  teamId: id
    .nullable()
    .optional()
    .describe('A team of the company, which covers its sub-teams too; null for the whole company'),
  enforcement: z
    .enum(BUDGET_ENFORCEMENTS)
    .optional()
    .describe(`strict refuses an order that goes over; advisory (default) only warns`),
  startsOn: z.iso
    .date()
    .optional()
    .describe('The day (UTC) it starts counting; today for a new budget'),
});
export type BudgetInput = z.infer<typeof budgetInput>;

/** A budget's lookup keys as an opaque cursor: the sort key (a name, or a time) and the id. */
export type BudgetCursor = { readonly key: string | number; readonly id: string };

export function encodeBudgetCursor(c: BudgetCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify([c.key, c.id]));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The cursor a page handed out, or undefined for anything else. */
export function decodeBudgetCursor(raw: string): BudgetCursor | undefined {
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      (typeof parsed[0] === 'string' || typeof parsed[0] === 'number') &&
      typeof parsed[1] === 'string'
    )
      return { key: parsed[0], id: parsed[1] };
  } catch {
    // Not one of ours.
  }
  return undefined;
}
