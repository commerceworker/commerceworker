/**
 * Companies through the assistant, REST's and the customer page's twin: reading companies and
 * their members, and the changes staff make: adding and editing a customer, moving a company
 * along its lifecycle, and keeping its members and teams. Each change stops for a confirm whose
 * card says what moves and what that does to orders (a company that isn't active has its orders
 * declined). Members are personal data: a card and the audit trail count them and name no one.
 * The use-cases are `@commerceworker/application`'s, the ones REST runs.
 */
import * as uc from '@commerceworker/application/commerce';
import {
  type ActionPreview,
  COMPANY_ROLE_LABELS,
  COMPANY_STATUS_LABELS,
  type CompanyStatus,
  newId,
  type Principal,
  type ToolInput,
} from '@commerceworker/core';
import { recordAudit } from '../audit';
import { companyDirectory } from '../wire';
import { Refused } from './data';

type Trail = Record<string, unknown>;

const ALL = { all: true } as const;
const ports = (env: Env) => ({ companies: companyDirectory(env) });

/** A read that can refuse (a bad cursor, an id nobody has) is a refusal, as REST's 400 and 404. */
function answer<T extends { ok: true } | { ok: false; error: string }>(r: T) {
  if (!r.ok) throw new Refused((r as { error: string }).error);
  const { ok: _, ...rest } = r as { ok: true };
  return rest as Omit<Extract<T, { ok: true }>, 'ok'>;
}

export const readCompanies = async (env: Env, i: ToolInput<'list_companies'>) =>
  answer(await uc.listCompanies(ports(env), ALL, i));

export async function readCompany(env: Env, i: ToolInput<'get_company'>) {
  const found = await uc.getCompany(ports(env), ALL, i.companyId);
  if (!found) throw new Refused('No such company.');
  return found;
}

export const readCompanyMembers = async (env: Env, i: ToolInput<'list_company_members'>) =>
  answer(await uc.listCompanyMembers(ports(env), ALL, i));

/** What a company's status means for its orders, in a card's words. */
const STATUS_EFFECT: Record<CompanyStatus, string> = {
  pending: 'Orders from it are declined until it is approved',
  active: 'Orders from it are accepted again',
  suspended: 'Orders from it are declined until it is reinstated; its members and teams are kept',
  rejected: 'Final: the application is turned down and it can never order',
  closed: 'Final: orders from it are declined for good; its members and teams are kept on record',
};

const href = (customerId: string) => `/customers/${customerId}`;

// ── Customers ──────────────────────────────────────────────────────────────

export async function previewCreateCustomer(
  env: Env,
  i: ToolInput<'create_customer'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planCreateCustomer(ports(env), i, 'preview', Date.now());
  const kind = plan.ok ? plan.input.kind : (i.kind ?? 'business');
  return {
    title: `Add ${kind === 'business' ? 'business ' : ''}customer ${i.name}`,
    href: '/commerce#customers',
    consequences: plan.ok
      ? [
          `${plan.input.kind} · ${plan.input.tier} tier · ${plan.input.terms.replace('_', ' ')}`,
          plan.company
            ? `Its company (${plan.company.legalName}) starts active, so orders from it are accepted`
            : 'No company: only business customers have one',
          'It starts with no credit limit, and one is set separately',
        ]
      : [],
    blocked: roleBlock ?? (plan.ok ? undefined : plan.error),
  };
}

export async function runCreateCustomer(
  env: Env,
  p: Principal,
  i: ToolInput<'create_customer'>,
  trail: Trail,
) {
  const id = newId('cus');
  const r = await uc.createCustomer(ports(env), i, id, Date.now());
  if (!r.ok) throw new Refused(r.error);
  if (r.audit)
    await recordAudit(env, r.audit.action, {
      actor: p,
      target: r.audit.target,
      detail: { ...r.audit.detail, ...trail },
    });
  return { done: `Added ${r.name}`, href: href(id), id };
}

export async function previewUpdateCustomer(
  env: Env,
  i: ToolInput<'update_customer'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planUpdateCustomer(ports(env), i, Date.now());
  if (!plan.ok)
    return { title: 'Change a customer', consequences: [], blocked: roleBlock ?? plan.error };
  const pricing = plan.changes.some((c) => c.field === 'tier' || c.field === 'kind');
  return {
    title: `Change ${plan.name}`,
    href: href(plan.customerId),
    consequences: [
      ...plan.changes.map((c) => `${c.field} ${c.from} → ${c.to}`),
      ...(pricing
        ? [
            'Orders from now on are priced for the new tier and kind; priced orders keep their price',
          ]
        : []),
      ...(plan.company ? ['It becomes a business customer: its company starts active'] : []),
    ],
    blocked: roleBlock ?? (plan.changes.length ? undefined : 'Nothing to change.'),
  };
}

export async function runUpdateCustomer(
  env: Env,
  p: Principal,
  i: ToolInput<'update_customer'>,
  trail: Trail,
) {
  const r = await uc.updateCustomer(ports(env), i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  if (r.audit)
    await recordAudit(env, r.audit.action, {
      actor: p,
      target: r.audit.target,
      detail: { ...r.audit.detail, ...trail },
    });
  return { done: `Changed ${r.name}`, href: href(r.customerId), id: r.customerId };
}

// ── Company status ─────────────────────────────────────────────────────────

export async function previewCompanyStatus(
  env: Env,
  i: ToolInput<'set_company_status'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planCompanyStatus(ports(env), ALL, i);
  if (!plan.ok)
    return {
      title: 'Change a company’s status',
      consequences: [],
      blocked: roleBlock ?? plan.error,
    };
  return {
    title: `Set ${plan.company.name} to ${COMPANY_STATUS_LABELS[i.status].toLowerCase()}`,
    href: href(plan.company.customerId),
    consequences: [
      `${COMPANY_STATUS_LABELS[plan.company.status]} → ${COMPANY_STATUS_LABELS[i.status]}`,
      STATUS_EFFECT[i.status],
      'Orders already running carry on',
    ],
    blocked: roleBlock ?? (plan.noop ? `${plan.company.name} is already ${i.status}.` : undefined),
  };
}

export async function runCompanyStatus(
  env: Env,
  p: Principal,
  i: ToolInput<'set_company_status'>,
  trail: Trail,
) {
  const r = await uc.setCompanyStatus(ports(env), ALL, i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  if (r.audit)
    await recordAudit(env, r.audit.action, {
      actor: p,
      target: r.audit.target,
      detail: { ...r.audit.detail, ...trail },
    });
  return {
    done: `Set ${r.company.name} to ${i.status}`,
    href: href(r.company.customerId),
    id: r.company.customerId,
  };
}

// ── Members ────────────────────────────────────────────────────────────────

export async function previewMembers(
  env: Env,
  i: ToolInput<'put_company_members'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planMembers(ports(env), ALL, i, () => 'preview');
  if (!plan.ok)
    return { title: 'Add or change members', consequences: [], blocked: roleBlock ?? plan.error };
  const roles = [...new Set(i.members.map((m) => m.role).filter((r) => r !== undefined))];
  return {
    title: `Add or change members of ${plan.company.name}`,
    href: href(plan.company.customerId),
    consequences: [
      `${plan.added} added, ${plan.edited} changed`,
      ...(roles.length ? [`Roles: ${roles.map((r) => COMPANY_ROLE_LABELS[r]).join(', ')}`] : []),
      'A member who is active can be the buyer on an order; invited, inactive and removed ones can’t',
    ],
    blocked: roleBlock ?? (plan.added || plan.edited ? undefined : 'Nothing to change.'),
  };
}

export async function runMembers(
  env: Env,
  p: Principal,
  i: ToolInput<'put_company_members'>,
  trail: Trail,
) {
  const r = await uc.addMembers(ports(env), ALL, i, Date.now(), () => newId('mem'));
  if (!r.ok) throw new Refused(r.error);
  if (r.audit)
    await recordAudit(env, r.audit.action, {
      actor: p,
      target: r.audit.target,
      detail: { ...r.audit.detail, ...trail },
    });
  return {
    done: `${r.added} added, ${r.edited} changed in ${r.company.name}`,
    href: href(r.company.customerId),
    id: r.company.customerId,
  };
}

export async function previewRemoveMember(
  env: Env,
  i: ToolInput<'remove_company_member'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planRemoveMember(ports(env), ALL, i);
  if (!plan.ok)
    return { title: 'Remove a member', consequences: [], blocked: roleBlock ?? plan.error };
  return {
    title: `Remove a ${COMPANY_ROLE_LABELS[plan.member.role].toLowerCase()} from ${plan.company.name}`,
    href: href(plan.company.customerId),
    consequences: [
      'Final: they can no longer be the buyer on an order',
      'Their record stays for the orders they placed',
    ],
    blocked: roleBlock ?? (plan.noop ? 'They are already removed.' : undefined),
  };
}

export async function runRemoveMember(
  env: Env,
  p: Principal,
  i: ToolInput<'remove_company_member'>,
  trail: Trail,
) {
  const r = await uc.removeMember(ports(env), ALL, i, Date.now());
  if (!r.ok) throw new Refused(r.error);
  if (r.audit)
    await recordAudit(env, r.audit.action, {
      actor: p,
      target: r.audit.target,
      detail: { ...r.audit.detail, ...trail },
    });
  return {
    done: `Removed a member of ${r.company.name}`,
    href: href(r.company.customerId),
    id: i.memberId,
  };
}

// ── Teams ──────────────────────────────────────────────────────────────────

export async function previewTeam(
  env: Env,
  i: ToolInput<'put_company_team'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const plan = await uc.planTeam(ports(env), ALL, i, () => 'preview');
  if (!plan.ok)
    return { title: 'Add or change a team', consequences: [], blocked: roleBlock ?? plan.error };
  return {
    title: `${plan.added ? 'Add' : 'Change'} team ${plan.team.name} in ${plan.company.name}`,
    href: href(plan.company.customerId),
    consequences: [
      plan.team.parentId ? 'Under another team' : 'At the top of the company',
      ...(plan.added ? [] : ['Teams under it move with it']),
    ],
    blocked: roleBlock,
  };
}

export async function runTeam(
  env: Env,
  p: Principal,
  i: ToolInput<'put_company_team'>,
  trail: Trail,
) {
  const r = await uc.putTeam(ports(env), ALL, i, () => newId('team'));
  if (!r.ok) throw new Refused(r.error);
  if (r.audit)
    await recordAudit(env, r.audit.action, {
      actor: p,
      target: r.audit.target,
      detail: { ...r.audit.detail, ...trail },
    });
  return { done: `Saved team ${r.team.name}`, href: href(r.company.customerId), id: r.team.id };
}
