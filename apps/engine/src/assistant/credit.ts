/**
 * Business customers' credit accounts through the assistant, REST's and the customer page's
 * twin: reading one, setting its limit, and adjusting its balance. A limit and a balance decide
 * what a customer may order on account, so both changes stop for a confirm whose card shows the
 * account now and after. The use-cases are `@commerceworker/application`'s, the ones REST runs.
 */
import {
  adjustCredit,
  getCreditAccount,
  planCreditAdjustment,
  planCreditLimit,
  setCreditLimit,
} from '@commerceworker/application/commerce';
import {
  type ActionPreview,
  BASE_CURRENCY,
  creditAvailable,
  newId,
  type Principal,
  type ToolInput,
} from '@commerceworker/core';
import { recordAudit } from '../audit';
import { balanceStore, companyDirectory, pricingStore } from '../wire';
import { money, Refused } from './data';

type Trail = Record<string, unknown>;

const ports = (env: Env) => ({
  balances: balanceStore(env),
  pricing: pricingStore(env),
  companies: companyDirectory(env),
});
const base = (n: number) => money(n, BASE_CURRENCY);

export async function readCreditAccount(env: Env, i: ToolInput<'get_credit_account'>) {
  const r = await getCreditAccount(ports(env), i.customerId, { after: i.after, limit: i.limit });
  if (!r.ok) throw new Refused(r.error);
  return r.value;
}

export async function previewCreditLimit(
  env: Env,
  i: ToolInput<'set_credit_limit'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const { current, problem } = await planCreditLimit(ports(env), i.customerId, i.limit);
  const after = current && creditAvailable({ ...current, creditLimit: i.limit });
  return {
    title: `Set ${i.customerId}’s credit limit to ${base(i.limit)}`,
    href: `/customers/${i.customerId}`,
    consequences: current
      ? [
          `Limit ${base(current.limit)}, then ${base(i.limit)}`,
          `Owed ${base(current.balance)}, held by open orders ${base(current.held)}`,
          `Available ${base(current.available)}, then ${base(after ?? 0)}`,
          ...(after !== null && after < 0
            ? [
                'Under what is owed and held: new orders on account are refused until it is paid down',
              ]
            : []),
          'Orders already holding credit keep their holds',
        ]
      : [],
    blocked: roleBlock ?? problem ?? undefined,
  };
}

export async function runCreditLimit(
  env: Env,
  p: Principal,
  i: ToolInput<'set_credit_limit'>,
  trail: Trail,
) {
  const r = await setCreditLimit(ports(env), i, p.email ?? p.name);
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, {
    actor: p,
    target: r.audit.target,
    detail: { ...r.audit.detail, ...trail },
  });
  return {
    done: `Set ${i.customerId}’s credit limit to ${base(r.limit)}`,
    href: `/customers/${i.customerId}`,
    id: i.customerId,
  };
}

export async function previewCreditAdjustment(
  env: Env,
  i: ToolInput<'adjust_credit'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const { current, problem } = await planCreditAdjustment(ports(env), i);
  const verb = i.amount < 0 ? 'Lower' : 'Raise';
  return {
    title: `${verb} ${i.customerId}’s balance by ${base(Math.abs(i.amount))}`,
    href: `/customers/${i.customerId}`,
    consequences: current
      ? [
          `Owed ${base(current.balance)}, then ${base(current.balance + i.amount)}`,
          `Available ${base(current.available)}, then ${base(current.available - i.amount)}`,
          `Recorded as an immutable ledger entry: “${i.reason.trim()}”`,
          'Undo it with another adjustment',
        ]
      : [],
    blocked: roleBlock ?? problem ?? undefined,
  };
}

export async function runCreditAdjustment(
  env: Env,
  p: Principal,
  i: ToolInput<'adjust_credit'>,
  trail: Trail,
  /** What the call was for, unique to it: a REST retry with the same key records once. */
  key?: string,
) {
  const r = await adjustCredit(ports(env), i, key ?? newId('adj'), p.email ?? p.name);
  if (!r.ok) throw new Refused(r.error);
  await recordAudit(env, r.audit.action, {
    actor: p,
    target: r.audit.target,
    detail: { ...r.audit.detail, ...trail },
  });
  return {
    done: `${i.amount < 0 ? 'Lowered' : 'Raised'} ${i.customerId}’s balance by ${base(Math.abs(i.amount))}`,
    href: `/customers/${i.customerId}`,
    id: r.entryId,
  };
}
