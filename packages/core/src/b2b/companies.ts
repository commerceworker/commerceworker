/**
 * Companies: a business customer's company (one to one, so nothing keyed by `customer_id` moves),
 * its teams (a tree), and its members: the people who buy, approve and administer for it. The
 * rules here, with no storage, are the two lifecycles, the fixed company roles, what an order from
 * a company or one of its members needs (`companyOrderProblem`), and what flows and promotion
 * conditions read of them (`accountContext`). `docs/b2b.md` is the plan; D1 (the business customer
 * is the company), D9 (fixed roles) and D11 (no company-bound tokens) are the defaults this is
 * built on, each a constant or one function below.
 */
import { z } from 'zod';
import { TERM_DAYS } from '../invoices';
import { defineLifecycle } from '../lifecycle';

/** D1: a company is a business customer's, so only these kinds have one. */
export const COMPANY_CUSTOMER_KIND = 'business';
export const CUSTOMER_KINDS = ['business', 'consumer', 'internal'] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];

export const COMPANY_STATUSES = ['pending', 'active', 'suspended', 'rejected', 'closed'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

/** A company is approved or rejected once; it can be suspended and reinstated; closing is final. */
export const COMPANY_LIFECYCLE = defineLifecycle<CompanyStatus>({
  pending: ['active', 'rejected'],
  active: ['suspended', 'closed'],
  suspended: ['active', 'closed'],
  rejected: [],
  closed: [],
});

export const COMPANY_STATUS_LABELS: Record<CompanyStatus, string> = {
  pending: 'Pending',
  active: 'Active',
  suspended: 'Suspended',
  rejected: 'Rejected',
  closed: 'Closed',
};

export const MEMBER_STATUSES = ['invited', 'active', 'inactive', 'removed'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** A removed member stays on record, for the orders they placed. */
export const MEMBER_LIFECYCLE = defineLifecycle<MemberStatus>({
  invited: ['active', 'removed'],
  active: ['inactive', 'removed'],
  inactive: ['active', 'removed'],
  removed: [],
});

export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  invited: 'Invited',
  active: 'Active',
  inactive: 'Inactive',
  removed: 'Removed',
};

/** The states a member may be given when added; anything later is a move (`MEMBER_LIFECYCLE`). */
export const MEMBER_START_STATUSES = ['invited', 'active'] as const;

/** D9: fixed company roles. A custom role would replace this list and `COMPANY_ROLE_LABELS`. */
export const COMPANY_ROLES = ['buyer', 'approver', 'company_admin'] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];
export const DEFAULT_COMPANY_ROLE: CompanyRole = 'buyer';

export const COMPANY_ROLE_LABELS: Record<CompanyRole, string> = {
  buyer: 'Buyer',
  approver: 'Approver',
  company_admin: 'Company admin',
};

/** Caps that keep a company's lists and a call's writes bounded. */
export const MAX_MEMBERS_PER_CALL = 100;
export const MAX_COMPANY_MEMBERS = 2000;
export const MAX_COMPANY_TEAMS = 200;
export const MAX_TEAM_DEPTH = 6;
export const MAX_COMPANY_DEPTH = 5;

export interface Company {
  /** The business customer's id: a company is its customer. */
  customerId: string;
  status: CompanyStatus;
  legalName: string;
  taxId: string | null;
  parentCompanyId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CompanyTeam {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  /** The ids from the root down, each followed by `/`: `/team_a/team_b/`. A subtree is a prefix. */
  path: string;
}

export interface CompanyMember {
  id: string;
  companyId: string;
  name: string;
  /** Lower case; unique within the company among members not removed. */
  email: string;
  role: CompanyRole;
  teamId: string | null;
  status: MemberStatus;
  /** The most one order of theirs may total, in the base currency; null for no limit of their own. */
  orderLimit: number | null;
  createdAt: number;
  updatedAt: number;
}

export const normalizeMemberEmail = (email: string) => email.trim().toLowerCase();

/** A team's path under its parent's (or the root's). */
export const teamPath = (parent: Pick<CompanyTeam, 'path'> | null, id: string) =>
  `${parent?.path ?? '/'}${id}/`;

/** How many teams deep a path is. */
export const teamDepth = (path: string) => path.split('/').filter(Boolean).length;

const id = z.string().min(1).max(100);

/** One member as a caller writes it: new, or the same email again to change them. */
export const companyMemberInput = z.object({
  email: z.email().max(254).describe('Their work email; unique within the company'),
  name: z.string().trim().min(1).max(120),
  role: z.enum(COMPANY_ROLES).optional().describe(`Defaults to ${DEFAULT_COMPANY_ROLE}`),
  teamId: id.nullable().optional().describe('A team of this company; null for none'),
  orderLimit: z
    .number()
    .positive()
    .max(1e9)
    .nullable()
    .optional()
    .describe('The most one order of theirs may total, base currency; null for none'),
  status: z
    .enum(['invited', 'active', 'inactive'])
    .optional()
    .describe('invited (default for a new member) or active when added; inactive pauses them'),
});
export type CompanyMemberInput = z.infer<typeof companyMemberInput>;
export const companyMembersInput = z.array(companyMemberInput).min(1).max(MAX_MEMBERS_PER_CALL);

export const companyTeamInput = z.object({
  companyId: id,
  teamId: id.optional().describe('Leave out to add a team; give one to rename or move it'),
  name: z.string().trim().min(1).max(80),
  parentTeamId: id.nullable().optional().describe('The team it sits under; null for the top'),
});
export type CompanyTeamInput = z.infer<typeof companyTeamInput>;

const tier = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'A tier is lower case letters, digits, - and _')
  .describe('The pricing tier, like standard or gold');

export const customerFields = {
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  kind: z.enum(CUSTOMER_KINDS),
  tier,
  terms: z.enum(Object.keys(TERM_DAYS) as [string, ...string[]]).describe('Payment terms'),
} as const;

/** What a new business customer's company starts with; consumers and internal accounts have none. */
export const companyDetailsInput = z.object({
  legalName: z.string().trim().min(1).max(200).optional().describe('Defaults to the name'),
  taxId: z.string().trim().min(1).max(64).optional(),
  parentCompanyId: id.optional().describe('The company this one belongs to'),
});

export const createCustomerInput = z.object({
  name: customerFields.name,
  email: customerFields.email,
  kind: customerFields.kind.default('business'),
  tier: customerFields.tier.default('standard'),
  terms: customerFields.terms.default('net_30'),
  company: companyDetailsInput.optional().describe('A business customer’s company details'),
});
export type CreateCustomerInput = z.infer<typeof createCustomerInput>;

/** The account fields staff change. The credit limit isn't one: it is its own change (S3). */
export const updateCustomerInput = z.object({
  customerId: id,
  name: customerFields.name.optional(),
  email: customerFields.email.optional(),
  kind: customerFields.kind.optional(),
  tier: customerFields.tier.optional(),
  terms: customerFields.terms.optional(),
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerInput>;

/** Whether a customer of this kind has a company. */
export const hasCompany = (kind: string) => kind === COMPANY_CUSTOMER_KIND;

/** A company's lookup keys as an opaque cursor: the sort key and the id. */
export type CompanyCursor = { readonly name: string; readonly id: string };

export function encodeCompanyCursor(c: CompanyCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify([c.name, c.id]));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The cursor a page handed out, or undefined for anything else. */
export function decodeCompanyCursor(raw: string): CompanyCursor | undefined {
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    )
      return { name: parsed[0], id: parsed[1] };
  } catch {
    // Not one of ours.
  }
  return undefined;
}

/** The `meta.buyerId` an order names, or undefined when it names none. */
export function orderBuyerId(meta: Record<string, unknown> | undefined): string | undefined {
  const v = meta?.buyerId;
  return typeof v === 'string' && v ? v : undefined;
}

/** What validating an order needs to know of its customer's company and its buyer. */
export type OrderAccount = {
  company: Pick<Company, 'status'> | undefined;
  buyer: Pick<CompanyMember, 'companyId' | 'status'> | undefined;
};

/**
 * Why an order can't be accepted from its company or buyer, or null. A customer with no company
 * (a consumer, an internal account) is never held to one. A company that isn't active orders
 * nothing; a buyer, when the order names one, must be an active member of the order's own company.
 */
export function companyOrderProblem(
  order: { customerId?: string | undefined; meta?: Record<string, unknown> | undefined },
  account: OrderAccount,
): string | null {
  const buyerId = order.meta?.buyerId;
  if (buyerId !== undefined && (typeof buyerId !== 'string' || !buyerId))
    return 'meta.buyerId must be a company member’s id';
  const { company, buyer } = account;
  if (company && company.status !== 'active')
    return `Company ${order.customerId} isn't active (${company.status})`;
  if (buyerId === undefined) return null;
  if (!company || !buyer || buyer.companyId !== order.customerId || buyer.status !== 'active')
    return `Buyer ${buyerId} isn't an active member of ${order.customerId ?? 'this order’s customer'}`;
  return null;
}

/**
 * What a flow's or a promotion's JSON Logic reads: `company.status` and `company.tier`, and
 * `buyer.role`, `buyer.team` (the team's id) and `buyer.orderLimit`. Each is null when there is no
 * company or buyer, as `customer.*` is for a guest.
 */
export type AccountContext = {
  company: { status: CompanyStatus | null; tier: string | null };
  buyer: { role: CompanyRole | null; team: string | null; orderLimit: number | null };
};

export const ACCOUNT_VARIABLES = {
  'company.status':
    'The buyer’s company status: pending, active, suspended, rejected or closed, or null',
  'company.tier': 'The company’s pricing tier, or null',
  'buyer.role': 'The ordering member’s company role: buyer, approver or company_admin, or null',
  'buyer.team': 'The id of the ordering member’s team, or null',
  'buyer.orderLimit': 'The ordering member’s own order limit in the base currency, or null',
} as const;

export function accountContext(
  customer: { tier: string } | null | undefined,
  company: Pick<Company, 'status'> | null | undefined,
  buyer: Pick<CompanyMember, 'role' | 'teamId' | 'orderLimit'> | null | undefined,
): AccountContext {
  return {
    company: { status: company?.status ?? null, tier: company ? (customer?.tier ?? null) : null },
    buyer: {
      role: buyer?.role ?? null,
      team: buyer?.teamId ?? null,
      orderLimit: buyer?.orderLimit ?? null,
    },
  };
}

/** Whether a company may take `parentId` as its parent without a loop or too deep a tree. */
export function parentCompanyProblem(
  companyId: string,
  parentId: string,
  chain: readonly string[],
): string | null {
  if (parentId === companyId) return 'A company can’t be its own parent.';
  if (chain.includes(companyId)) return 'That would make the company its own ancestor.';
  if (chain.length >= MAX_COMPANY_DEPTH) return `Companies nest at most ${MAX_COMPANY_DEPTH} deep.`;
  return null;
}
