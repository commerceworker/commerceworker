/**
 * Budgets as an order and as staff meet them (`b2b/budgets.ts` in core). An order is checked
 * against the budgets of its company and its buyer's team (`checkBudgets`), its total recorded as
 * spend when the flow asks (`commitBudgetSpend`) and given back when it rolls back
 * (`reverseBudgetSpend`). Staff and agents read, add, change and move budgets (`listBudgets`,
 * `putBudget`, `setBudgetStatus`); the REST routes, the MCP tools and the customer page all run
 * these. Each change is a `plan…` that reads and judges (a preview shows its refusal) and a write
 * that plans again, so a stale preview can't push past a rule. Time and new ids come in as
 * arguments; the caller records the audit draft.
 *
 * Spend is summed per window from the ledger, never kept as a counter, so nothing here resets or
 * adds to one.
 */
import {
  BUDGET_LIFECYCLE,
  BUDGET_PAGE,
  type Budget,
  type BudgetEnforcement,
  type BudgetStatus,
  type BudgetUse,
  budgetChecks,
  budgetInput,
  budgetReversalId,
  budgetSpendAmount,
  budgetSpendId,
  budgetTeamIds,
  budgetWindow,
  budgetWindows,
  decodeBudgetCursor,
  encodeBudgetCursor,
  MAX_COMPANY_BUDGETS,
  money,
  SPEND_PAGE,
  spendKey,
} from '@commerceworker/core';
import type {
  BudgetScope,
  BudgetStore,
  CompanyDirectory,
  SpendEntry,
} from '@commerceworker/ports/commerce';
import type { AuditDraft } from './audit-trail';

export type BudgetPorts = {
  readonly budgets: BudgetStore;
  readonly companies: CompanyDirectory;
};

const ALL: BudgetScope = { all: true };
const DAY = 86_400_000;

const refuse = (error: string) => ({ ok: false as const, error });
type Refused = ReturnType<typeof refuse>;

/** What a change did; `audit` is null when it changed nothing (a repeat). */
export type BudgetChange<T = Record<string, never>> =
  | ({ ok: true; changed: boolean; audit: AuditDraft | null } & T)
  | Refused;

const firstIssue = (e: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}) => {
  const i = e.issues[0];
  return i ? `${i.path.join('.') || 'input'}: ${i.message}` : 'Not a valid request.';
};

// ── Checking an order ──────────────────────────────────────────────────────

/** The order, as a budget check reads it. */
export type BudgetOrder = {
  id: string;
  customerId?: string | undefined;
  total: number;
  baseTotal?: number | undefined;
  fxRate?: number | undefined;
};

/** The ids a step's own ledger rows have, so a retry judges the budgets as the first attempt did. */
const ownRows = (orderId: string, stepKey: string, budgets: readonly Budget[]) =>
  budgets.flatMap((b) => {
    const id = budgetSpendId(orderId, stepKey, b.id);
    return [id, budgetReversalId(id)];
  });

/**
 * An order against the budgets of its company and the buyer's team (and those above it): each
 * one's remaining, whether the order exceeds it and an advisory budget's warning. `within` is false
 * only when a strict budget would go below zero. An order with no company, or a company with no
 * budgets in force, is within. `uses` are the budgets in force, for `commitBudgetSpend`.
 */
export async function checkBudgets(
  ports: BudgetPorts,
  order: BudgetOrder,
  stepKey: string,
  teamId: string | null,
  now: number,
) {
  const none = { within: true, checks: [], uses: [] as BudgetUse[], total: 0 };
  if (!order.customerId) return none;
  const total = budgetSpendAmount(order);
  const teamIds = teamId
    ? budgetTeamIds(
        (await ports.companies.teams(ALL, order.customerId)).find((t) => t.id === teamId)?.path,
      )
    : [];
  const budgets = await ports.budgets.applicable(ALL, order.customerId, teamIds);
  const inForce = budgetWindows(budgets, now);
  if (!inForce.length) return { ...none, total };
  const sums = await ports.budgets.spentIn(
    inForce.map(({ budget, window }) => ({ budgetId: budget.id, windowStart: window.start })),
    ownRows(order.id, stepKey, budgets),
  );
  const uses = inForce.map(
    ({ budget, window }): BudgetUse => ({
      budget,
      window,
      spent: sums.get(spendKey(budget.id, window.start)) ?? 0,
    }),
  );
  return { ...budgetChecks(total, uses), uses, total };
}

/**
 * Records the order's total against every budget it was checked against, all or none: false when a
 * strict budget filled in the meantime (another order committed first), with nothing written. A
 * step that retries finds its own rows and says true.
 */
export function commitBudgetSpend(
  ports: Pick<BudgetPorts, 'budgets'>,
  order: BudgetOrder,
  stepKey: string,
  uses: readonly BudgetUse[],
  now: number,
): Promise<boolean> {
  const amount = budgetSpendAmount(order);
  return ports.budgets.commit({
    orderId: order.id,
    stepKey,
    at: now,
    lines: uses.map((u) => ({ budgetId: u.budget.id, amount, window: u.window })),
  });
}

/** Compensation: gives back the order's recorded spend, each commit once. Returns how many it reversed. */
export const reverseBudgetSpend = (
  ports: Pick<BudgetPorts, 'budgets'>,
  orderId: string,
  now: number,
): Promise<number> => ports.budgets.reverse(orderId, now);

// ── Reads ──────────────────────────────────────────────────────────────────

function cursorOf(raw: string | undefined) {
  if (raw === undefined) return { ok: true as const, after: undefined };
  const after = decodeBudgetCursor(raw);
  return after ? { ok: true as const, after } : refuse('That cursor isn’t one a page returned.');
}

/** A budget as the tools show it, with what the window it counts `now` in has spent. */
export function budgetView(b: Budget, spent: number, now: number) {
  const window = budgetWindow(b.period, b.anchor, now);
  return {
    id: b.id,
    companyId: b.companyId,
    teamId: b.teamId,
    name: b.name,
    amount: b.amount,
    period: b.period,
    anchor: b.anchor,
    enforcement: b.enforcement,
    status: b.status,
    window,
    spent: money(spent),
    remaining: money(b.amount - spent),
  };
}

export async function listBudgets(
  ports: Pick<BudgetPorts, 'budgets'>,
  scope: BudgetScope,
  q: { companyId: string; teamId?: string; status?: BudgetStatus; cursor?: string; limit?: number },
  now: number,
) {
  const at = cursorOf(q.cursor);
  if (!at.ok) return at;
  const page = await ports.budgets.budgets(scope, {
    companyId: q.companyId,
    teamId: q.teamId,
    status: q.status,
    after: at.after,
    limit: q.limit ?? BUDGET_PAGE.default,
  });
  // The whole page's spend in one statement.
  const windows = page.rows.flatMap((b) => {
    const w = budgetWindow(b.period, b.anchor, now);
    return w ? [{ budgetId: b.id, windowStart: w.start }] : [];
  });
  const sums = await ports.budgets.spentIn(windows);
  const spentOf = (b: Budget) => {
    const w = budgetWindow(b.period, b.anchor, now);
    return w ? (sums.get(spendKey(b.id, w.start)) ?? 0) : 0;
  };
  return {
    ok: true as const,
    budgets: page.rows.map((b) => budgetView(b, spentOf(b), now)),
    total: page.total,
    cursor: page.next ? encodeBudgetCursor(page.next) : null,
  };
}

/** A ledger row as the page shows it. */
export const spendView = (e: SpendEntry) => ({
  id: e.id,
  orderId: e.orderId,
  amount: e.amount,
  windowStart: e.windowStart,
  at: e.at,
  status: e.reversed ? ('reversed' as const) : ('committed' as const),
});

/** A budget's spend ledger, newest first, with whether each commit was since reversed. */
export async function listBudgetSpend(
  ports: Pick<BudgetPorts, 'budgets'>,
  scope: BudgetScope,
  q: { budgetId: string; cursor?: string; limit?: number },
) {
  const at = cursorOf(q.cursor);
  if (!at.ok) return at;
  const page = await ports.budgets.entries(scope, {
    budgetId: q.budgetId,
    after: at.after,
    limit: q.limit ?? SPEND_PAGE.default,
  });
  return {
    ok: true as const,
    entries: page.rows.map(spendView),
    total: page.total,
    cursor: page.next ? encodeBudgetCursor(page.next) : null,
  };
}

// ── Adding and changing a budget ───────────────────────────────────────────

export type BudgetPlan = {
  ok: true;
  company: { id: string; name: string };
  /** The budget as it would be written. */
  budget: Budget;
  added: boolean;
  /** Which of name, amount and enforcement it changes; empty for a repeat. */
  changes: string[];
};

/** What adding or changing a budget would do, or why not. */
export async function planBudget(
  ports: BudgetPorts,
  scope: BudgetScope,
  raw: unknown,
  newId: () => string,
  now: number,
): Promise<BudgetPlan | Refused> {
  const parsed = budgetInput.safeParse(raw);
  if (!parsed.success) return refuse(firstIssue(parsed.error));
  const input = parsed.data;
  const company = await ports.companies.company(scope, input.companyId);
  if (!company) return refuse('No such company.');
  if (company.status === 'closed' || company.status === 'rejected')
    return refuse(`${company.name} is ${company.status}: its budgets are no longer changed.`);
  const held = input.budgetId ? await ports.budgets.budget(scope, input.budgetId) : undefined;
  if (input.budgetId && (!held || held.companyId !== company.customerId))
    return refuse('No such budget.');
  const who = { id: company.customerId, name: company.name };

  if (held) {
    if (held.status === 'archived') return refuse(`${held.name} is archived, which is final.`);
    // The ledger counts in these, so changing one would orphan what it has recorded.
    if (input.period !== undefined && input.period !== held.period)
      return refuse('A budget’s period can’t change: add a new budget instead.');
    if (input.teamId !== undefined && input.teamId !== held.teamId)
      return refuse('A budget’s team can’t change: add a new budget instead.');
    if (input.startsOn !== undefined && Date.parse(input.startsOn) !== held.anchor)
      return refuse('A budget’s start can’t change: add a new budget instead.');
    const budget: Budget = {
      ...held,
      name: input.name,
      amount: money(input.amount),
      enforcement: input.enforcement ?? held.enforcement,
      updatedAt: now,
    };
    const changes = [
      ...(budget.name !== held.name ? ['name'] : []),
      ...(budget.amount !== held.amount ? ['amount'] : []),
      ...(budget.enforcement !== held.enforcement ? ['enforcement'] : []),
    ];
    return { ok: true, company: who, budget, added: false, changes };
  }

  if (!input.period) return refuse('period: a new budget needs a period.');
  if (input.teamId) {
    const teams = await ports.companies.teams(scope, company.customerId);
    if (!teams.some((t) => t.id === input.teamId)) return refuse('No such team in this company.');
  }
  const total = (await ports.budgets.budgets(scope, { companyId: company.customerId, limit: 1 }))
    .total;
  if (total >= MAX_COMPANY_BUDGETS)
    return refuse(`A company holds at most ${MAX_COMPANY_BUDGETS} budgets: archive one first.`);
  const budget: Budget = {
    id: newId(),
    companyId: company.customerId,
    teamId: input.teamId ?? null,
    name: input.name,
    amount: money(input.amount),
    period: input.period,
    anchor: input.startsOn ? Date.parse(input.startsOn) : Math.floor(now / DAY) * DAY,
    enforcement: input.enforcement ?? ('advisory' satisfies BudgetEnforcement),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, company: who, budget, added: true, changes: [] };
}

export async function putBudget(
  ports: BudgetPorts,
  scope: BudgetScope,
  raw: unknown,
  newId: () => string,
  now: number,
): Promise<BudgetChange<{ company: { id: string; name: string }; budget: Budget }>> {
  const plan = await planBudget(ports, scope, raw, newId, now);
  if (!plan.ok) return plan;
  const { company, budget, added, changes } = plan;
  if (!added && !changes.length) return { ok: true, changed: false, company, budget, audit: null };
  if (!(await ports.budgets.put(budget))) return refuse('No such budget.');
  return {
    ok: true,
    changed: true,
    company,
    budget,
    audit: {
      action: 'budget.saved',
      target: budget.id,
      detail: {
        company: company.id,
        amount: budget.amount,
        period: budget.period,
        enforcement: budget.enforcement,
        ...(budget.teamId ? { team: budget.teamId } : {}),
        ...(added ? { added: true } : { changed: changes }),
      },
    },
  };
}

// ── Budget status ──────────────────────────────────────────────────────────

export type BudgetStatusPlan = { ok: true; budget: Budget; to: BudgetStatus; noop: boolean };

/** What moving a budget to `to` would do, or why it can't. */
export async function planBudgetStatus(
  ports: Pick<BudgetPorts, 'budgets'>,
  scope: BudgetScope,
  input: { companyId: string; budgetId: string; status: BudgetStatus },
): Promise<BudgetStatusPlan | Refused> {
  const budget = await ports.budgets.budget(scope, input.budgetId);
  if (!budget || budget.companyId !== input.companyId) return refuse('No such budget.');
  if (budget.status === input.status) return { ok: true, budget, to: input.status, noop: true };
  if (!BUDGET_LIFECYCLE.can(budget.status, input.status))
    return refuse(
      BUDGET_LIFECYCLE.terminal(budget.status)
        ? `${budget.name} is ${budget.status}, which is final.`
        : `A ${budget.status} budget can’t become ${input.status}: it can become ${BUDGET_LIFECYCLE.next(budget.status).join(' or ')}.`,
    );
  return { ok: true, budget, to: input.status, noop: false };
}

export async function setBudgetStatus(
  ports: Pick<BudgetPorts, 'budgets'>,
  scope: BudgetScope,
  input: { companyId: string; budgetId: string; status: BudgetStatus },
  now: number,
): Promise<BudgetChange<{ budget: Budget }>> {
  const plan = await planBudgetStatus(ports, scope, input);
  if (!plan.ok) return plan;
  if (plan.noop) return { ok: true, changed: false, budget: plan.budget, audit: null };
  const { budget, to } = plan;
  if (!(await ports.budgets.transition(scope, budget.id, budget.status, to, now))) {
    // Someone moved it between the read and the write: say so, unless they moved it where it was
    // going (a retry of the same request).
    const now2 = await ports.budgets.budget(scope, budget.id);
    if (now2?.status === to) return { ok: true, changed: false, budget: now2, audit: null };
    return refuse(`${budget.name} changed meanwhile (now ${now2?.status ?? 'gone'}): look again.`);
  }
  return {
    ok: true,
    changed: true,
    budget: { ...budget, status: to, updatedAt: now },
    audit: {
      action: 'budget.status_changed',
      target: budget.id,
      detail: { company: budget.companyId, from: budget.status, to },
    },
  };
}
