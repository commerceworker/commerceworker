/**
 * Budgets through the assistant, REST's and the customer page's twin: reading a company's budgets
 * with what their current window has spent, and the changes staff make: adding and editing a
 * budget, and pausing, resuming or archiving it. Each change stops for a confirm whose card says
 * what it does to orders (a strict budget declines one that would take it below zero; an advisory
 * one only warns). The use-cases are `@commerceworker/application`'s, the ones REST runs.
 */
import * as uc from '@commerceworker/application/commerce';
import {
  type ActionPreview,
  BASE_CURRENCY,
  BUDGET_ENFORCEMENT_LABELS,
  BUDGET_PERIOD_LABELS,
  BUDGET_STATUS_LABELS,
  type BudgetStatus,
  newId,
  type Principal,
  type ToolInput,
} from '@commerceworker/core';
import { recordAudit } from '../audit';
import { budgetStore, companyDirectory } from '../wire';
import { Refused } from './data';

type Trail = Record<string, unknown>;

const ALL = { all: true } as const;
const ports = (env: Env) => ({ budgets: budgetStore(env), companies: companyDirectory(env) });

export async function readBudgets(env: Env, i: ToolInput<'list_budgets'>) {
  const r = await uc.listBudgets(ports(env), ALL, i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  const { ok: _, ...rest } = r;
  return rest;
}

/** A budget's ledger, held to the company the path or the call names: another company's reads empty. */
export async function readBudgetSpend(env: Env, i: ToolInput<'list_budget_spend'>) {
  const r = await uc.listBudgetSpend(ports(env), { companyId: i.companyId }, i);
  if (!r.ok) throw new Refused(r.error);
  const { ok: _, ...rest } = r;
  return rest;
}

/** What a budget's status means for orders, in a card's words. */
const STATUS_EFFECT: Record<BudgetStatus, string> = {
  active: 'Orders are held to it again',
  paused: 'Orders aren’t held to it while it is paused; what it has spent is kept',
  archived: 'Final: orders are no longer held to it; its spend stays on record',
};

const href = (companyId: string) => `/customers/${companyId}#budgets`;

const PER: Record<string, string> = {
  weekly: 'a week',
  monthly: 'a month',
  quarterly: 'a quarter',
  yearly: 'a year',
  one_time: 'in all',
};
const amountText = (amount: number, period: string) =>
  `${amount} ${BASE_CURRENCY} ${PER[period] ?? period}`;

export async function previewBudget(
  env: Env,
  i: ToolInput<'put_budget'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planBudget(ports(env), ALL, i, () => 'preview', Date.now());
  if (!plan.ok)
    return { title: 'Add or change a budget', consequences: [], blocked: roleBlock ?? plan.error };
  const b = plan.budget;
  return {
    title: `${plan.added ? 'Add' : 'Change'} budget ${b.name} for ${plan.company.name}`,
    href: href(plan.company.id),
    consequences: [
      `${BUDGET_PERIOD_LABELS[b.period]}: ${amountText(b.amount, b.period)}`,
      b.teamId ? 'For one team and the teams under it' : 'For the whole company',
      b.enforcement === 'strict'
        ? 'Strict: an order that would take it below zero is declined'
        : 'Advisory: an order over it passes, with a warning',
      'Only a flow whose budget check uses the company’s budgets is held to it',
      ...(plan.added ? [] : [`Changes: ${plan.changes.join(', ') || 'nothing'}`]),
    ],
    blocked: roleBlock ?? (plan.added || plan.changes.length ? undefined : 'Nothing to change.'),
  };
}

export async function runBudget(env: Env, p: Principal, i: ToolInput<'put_budget'>, trail: Trail) {
  const r = await uc.putBudget(ports(env), ALL, i, () => newId('bud'), Date.now());
  if (!r.ok) throw new Refused(r.error);
  if (r.audit)
    await recordAudit(env, r.audit.action, {
      actor: p,
      target: r.audit.target,
      detail: { ...r.audit.detail, ...trail },
    });
  return { done: `Saved budget ${r.budget.name}`, href: href(r.company.id), id: r.budget.id };
}

export async function previewBudgetStatus(
  env: Env,
  i: ToolInput<'set_budget_status'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planBudgetStatus(ports(env), ALL, i);
  if (!plan.ok)
    return {
      title: 'Change a budget’s status',
      consequences: [],
      blocked: roleBlock ?? plan.error,
    };
  return {
    title: `Set budget ${plan.budget.name} to ${BUDGET_STATUS_LABELS[plan.to].toLowerCase()}`,
    href: href(plan.budget.companyId),
    consequences: [
      `${BUDGET_ENFORCEMENT_LABELS[plan.budget.enforcement]} budget`,
      STATUS_EFFECT[plan.to],
    ],
    blocked: roleBlock ?? (plan.noop ? `It is already ${plan.to}.` : undefined),
  };
}

export async function runBudgetStatus(
  env: Env,
  p: Principal,
  i: ToolInput<'set_budget_status'>,
  trail: Trail,
) {
  const r = await uc.setBudgetStatus(ports(env), ALL, i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  if (r.audit)
    await recordAudit(env, r.audit.action, {
      actor: p,
      target: r.audit.target,
      detail: { ...r.audit.detail, ...trail },
    });
  return {
    done: `Budget ${r.budget.name} is ${r.budget.status}`,
    href: href(r.budget.companyId),
    id: r.budget.id,
  };
}
