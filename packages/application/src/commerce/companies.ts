/**
 * Companies as staff and agents manage them (`b2b/companies.ts` in core): reading them, creating
 * and editing the customer accounts they hang off, moving a company along its lifecycle, and
 * keeping its teams and members. The REST routes, the MCP tools and the customer page all run
 * these. Each change is a `plan…` that reads and judges (a preview shows its refusal) and a
 * write that plans again, so a stale preview can't push past a rule; a status moves by a guarded
 * compare-and-set on the state the plan read, and a move that lost the race says so. Time and new
 * ids come in as arguments; the caller records the audit draft.
 */
import {
  COMPANY_LIFECYCLE,
  type Company,
  type CompanyMember,
  type CompanyRole,
  type CompanyStatus,
  type CompanyTeam,
  type CreateCustomerInput,
  companyMembersInput,
  companyTeamInput,
  createCustomerInput,
  DEFAULT_COMPANY_ROLE,
  decodeCompanyCursor,
  encodeCompanyCursor,
  hasCompany,
  MAX_COMPANY_MEMBERS,
  MAX_COMPANY_TEAMS,
  MAX_TEAM_DEPTH,
  MEMBER_LIFECYCLE,
  MEMBER_START_STATUSES,
  type MemberStatus,
  normalizeMemberEmail,
  parentCompanyProblem,
  teamDepth,
  teamPath,
  updateCustomerInput,
} from '@commerceworker/core';
import type {
  CompanyDirectory,
  CompanyRecord,
  CompanyScope,
  MemberWrite,
} from '@commerceworker/ports/commerce';
import type { AuditDraft } from './audit-trail';

export type CompanyPorts = { readonly companies: CompanyDirectory };

const ALL: CompanyScope = { all: true };

const refuse = (error: string) => ({ ok: false as const, error });
type Refused = ReturnType<typeof refuse>;

/** What a change did; `audit` is null when it changed nothing (a repeat). */
export type CompanyChange<T = Record<string, never>> =
  | ({ ok: true; changed: boolean; audit: AuditDraft | null } & T)
  | Refused;

const firstIssue = (e: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}) => {
  const i = e.issues[0];
  return i ? `${i.path.join('.') || 'input'}: ${i.message}` : 'Not a valid request.';
};

/** A company as the tools show it. */
export const companyView = (c: CompanyRecord) => ({
  id: c.customerId,
  name: c.name,
  status: c.status,
  legalName: c.legalName,
  taxId: c.taxId,
  parentCompanyId: c.parentCompanyId,
  tier: c.tier,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

/** A member as the tools show them. */
export const memberView = (m: CompanyMember) => ({
  id: m.id,
  companyId: m.companyId,
  name: m.name,
  email: m.email,
  role: m.role,
  teamId: m.teamId,
  status: m.status,
  orderLimit: m.orderLimit,
});

// ── Reads ──────────────────────────────────────────────────────────────────

function cursorOf(raw: string | undefined) {
  if (raw === undefined) return { ok: true as const, after: undefined };
  const after = decodeCompanyCursor(raw);
  return after ? { ok: true as const, after } : refuse('That cursor isn’t one a page returned.');
}

export async function listCompanies(
  ports: CompanyPorts,
  scope: CompanyScope,
  q: { status?: CompanyStatus; search?: string; cursor?: string; limit?: number },
) {
  const at = cursorOf(q.cursor);
  if (!at.ok) return at;
  const page = await ports.companies.companies(scope, {
    status: q.status,
    search: q.search,
    after: at.after,
    limit: q.limit ?? 25,
  });
  return {
    ok: true as const,
    companies: page.rows.map(companyView),
    total: page.total,
    cursor: page.next ? encodeCompanyCursor(page.next) : null,
  };
}

/** One company with its team tree, or null for an id the scope can't see. */
export async function getCompany(ports: CompanyPorts, scope: CompanyScope, companyId: string) {
  const company = await ports.companies.company(scope, companyId);
  if (!company) return null;
  return {
    company: companyView(company),
    teams: (await ports.companies.teams(scope, companyId)).map(({ companyId: _, ...t }) => t),
  };
}

export async function listCompanyMembers(
  ports: CompanyPorts,
  scope: CompanyScope,
  q: {
    companyId: string;
    status?: MemberStatus;
    role?: CompanyRole;
    teamId?: string;
    cursor?: string;
    limit?: number;
  },
) {
  const at = cursorOf(q.cursor);
  if (!at.ok) return at;
  if (!(await ports.companies.company(scope, q.companyId))) return refuse('No such company.');
  const page = await ports.companies.members(scope, {
    companyId: q.companyId,
    status: q.status,
    role: q.role,
    teamId: q.teamId,
    after: at.after,
    limit: q.limit ?? 25,
  });
  return {
    ok: true as const,
    members: page.rows.map(memberView),
    total: page.total,
    cursor: page.next ? encodeCompanyCursor(page.next) : null,
  };
}

// ── Customers ──────────────────────────────────────────────────────────────

/** Why a parent company can't be this company's, or null. */
async function parentProblem(ports: CompanyPorts, companyId: string, parentId: string) {
  const parent = await ports.companies.company(ALL, parentId);
  if (!parent) return `No company ${parentId} to be its parent.`;
  const chain = [parentId, ...(await ports.companies.ancestry(ALL, parentId))];
  return parentCompanyProblem(companyId, parentId, chain);
}

export type CustomerPlan = {
  ok: true;
  id: string;
  input: CreateCustomerInput;
  company: Company | null;
};

/** What adding a customer would do: its company (a business customer's, active at once). */
export async function planCreateCustomer(
  ports: CompanyPorts,
  raw: unknown,
  id: string,
  now: number,
): Promise<CustomerPlan | Refused> {
  const parsed = createCustomerInput.safeParse(raw);
  if (!parsed.success) return refuse(firstIssue(parsed.error));
  const input = parsed.data;
  if (await ports.companies.customerByEmail(ALL, input.email))
    return refuse(`A customer with the email ${input.email} already exists.`);
  if (!hasCompany(input.kind)) {
    if (input.company)
      return refuse(`Only a business customer has a company, not a ${input.kind} one.`);
    return { ok: true, id, input, company: null };
  }
  const details = input.company;
  if (details?.parentCompanyId) {
    const why = await parentProblem(ports, id, details.parentCompanyId);
    if (why) return refuse(why);
  }
  return {
    ok: true,
    id,
    input,
    company: {
      customerId: id,
      status: 'active',
      legalName: details?.legalName ?? input.name,
      taxId: details?.taxId ?? null,
      parentCompanyId: details?.parentCompanyId ?? null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** Adds a customer, and a business customer's company, in one write. */
export async function createCustomer(
  ports: CompanyPorts,
  raw: unknown,
  id: string,
  now: number,
): Promise<CompanyChange<{ customerId: string; name: string }>> {
  const plan = await planCreateCustomer(ports, raw, id, now);
  if (!plan.ok) return plan;
  const { name, email, kind, tier, terms } = plan.input;
  if (!(await ports.companies.createCustomer({ id, name, email, kind, tier, terms }, plan.company)))
    return refuse('That customer id is taken.');
  return {
    ok: true,
    changed: true,
    customerId: id,
    name,
    audit: {
      action: 'customer.created',
      target: id,
      detail: { kind, tier, terms, company: plan.company !== null },
    },
  };
}

export type UpdatePlan = {
  ok: true;
  customerId: string;
  name: string;
  /** The fields that change, with what they were. */
  changes: { field: string; from: string; to: string }[];
  patch: Record<string, string>;
  /** A company the change creates: a customer made a business one. */
  company: Company | null;
};

const TERMINAL_COMPANY = (s: CompanyStatus) => COMPANY_LIFECYCLE.terminal(s);

/** What changing a customer would do, or why not. */
export async function planUpdateCustomer(
  ports: CompanyPorts,
  raw: unknown,
  now: number,
): Promise<UpdatePlan | Refused> {
  const parsed = updateCustomerInput.safeParse(raw);
  if (!parsed.success) return refuse(firstIssue(parsed.error));
  const { customerId, ...asked } = parsed.data;
  const customer = await ports.companies.customer(ALL, customerId);
  if (!customer) return refuse('No such customer.');
  const changes: UpdatePlan['changes'] = [];
  const patch: Record<string, string> = {};
  for (const field of ['name', 'email', 'kind', 'tier', 'terms'] as const) {
    const to = asked[field];
    if (to !== undefined && to !== customer[field]) {
      changes.push({ field, from: customer[field], to });
      patch[field] = to;
    }
  }
  if (patch.email) {
    const taken = await ports.companies.customerByEmail(ALL, patch.email);
    if (taken && taken.id !== customerId)
      return refuse(`A customer with the email ${patch.email} already exists.`);
  }
  let company: Company | null = null;
  if (patch.kind) {
    const held = await ports.companies.company(ALL, customerId);
    if (hasCompany(patch.kind)) {
      if (held && TERMINAL_COMPANY(held.status))
        return refuse(`Its company is ${held.status}, which is final: add a new customer instead.`);
      if (!held)
        company = {
          customerId,
          status: 'active',
          legalName: patch.name ?? customer.name,
          taxId: null,
          parentCompanyId: null,
          createdAt: now,
          updatedAt: now,
        };
    } else if (held && !TERMINAL_COMPANY(held.status)) {
      return refuse(
        `Its company is ${held.status}: close or reject it first, then change the customer’s kind.`,
      );
    }
  }
  return { ok: true, customerId, name: patch.name ?? customer.name, changes, patch, company };
}

export async function updateCustomer(
  ports: CompanyPorts,
  raw: unknown,
  now: number,
): Promise<CompanyChange<{ customerId: string; name: string }>> {
  const plan = await planUpdateCustomer(ports, raw, now);
  if (!plan.ok) return plan;
  if (!plan.changes.length)
    return { ok: true, changed: false, customerId: plan.customerId, name: plan.name, audit: null };
  if (!(await ports.companies.updateCustomer(plan.customerId, plan.patch)))
    return refuse('No such customer.');
  if (plan.company) await ports.companies.createCompany(plan.company);
  return {
    ok: true,
    changed: true,
    customerId: plan.customerId,
    name: plan.name,
    audit: {
      action: 'customer.updated',
      target: plan.customerId,
      detail: {
        // Names and emails are personal data: the audit keeps which fields moved, and the kind
        // and tier, never what a name or email was.
        fields: plan.changes.map((c) => c.field),
        ...Object.fromEntries(
          plan.changes
            .filter((c) => c.field !== 'name' && c.field !== 'email')
            .map((c) => [c.field, { from: c.from, to: c.to }]),
        ),
        ...(plan.company ? { company: true } : {}),
      },
    },
  };
}

// ── Company status ─────────────────────────────────────────────────────────

export type StatusPlan = { ok: true; company: CompanyRecord; to: CompanyStatus; noop: boolean };

/** What moving a company to `to` would do, or why it can't. */
export async function planCompanyStatus(
  ports: CompanyPorts,
  scope: CompanyScope,
  input: { companyId: string; status: CompanyStatus },
): Promise<StatusPlan | Refused> {
  const company = await ports.companies.company(scope, input.companyId);
  if (!company) return refuse('No such company.');
  if (company.status === input.status) return { ok: true, company, to: input.status, noop: true };
  if (!COMPANY_LIFECYCLE.can(company.status, input.status))
    return refuse(
      COMPANY_LIFECYCLE.terminal(company.status)
        ? `${company.name} is ${company.status}, which is final.`
        : `A ${company.status} company can’t become ${input.status}: it can become ${COMPANY_LIFECYCLE.next(company.status).join(' or ')}.`,
    );
  return { ok: true, company, to: input.status, noop: false };
}

export async function setCompanyStatus(
  ports: CompanyPorts,
  scope: CompanyScope,
  input: { companyId: string; status: CompanyStatus },
  now: number,
): Promise<CompanyChange<{ company: CompanyRecord }>> {
  const plan = await planCompanyStatus(ports, scope, input);
  if (!plan.ok) return plan;
  if (plan.noop) return { ok: true, changed: false, company: plan.company, audit: null };
  const { company, to } = plan;
  if (
    !(await ports.companies.transitionCompany(scope, company.customerId, company.status, to, now))
  ) {
    // Someone moved it between the read and the write: say so, unless they moved it where it was
    // going (a retry of the same request).
    const now2 = await ports.companies.company(scope, company.customerId);
    if (now2?.status === to) return { ok: true, changed: false, company: now2, audit: null };
    return refuse(`${company.name} changed meanwhile (now ${now2?.status ?? 'gone'}): look again.`);
  }
  return {
    ok: true,
    changed: true,
    company: { ...company, status: to, updatedAt: now },
    audit: {
      action: 'company.status_changed',
      target: company.customerId,
      detail: { from: company.status, to },
    },
  };
}

// ── Members ────────────────────────────────────────────────────────────────

export type MemberPlan = {
  ok: true;
  company: CompanyRecord;
  writes: MemberWrite[];
  /** Members to move once written: the move, from the status read. */
  moves: { id: string; from: MemberStatus; to: MemberStatus }[];
  added: number;
  /** Existing members whose fields or status change. */
  edited: number;
};

/** What putting these members would do, or why not. */
export async function planMembers(
  ports: CompanyPorts,
  scope: CompanyScope,
  raw: { companyId: string; members: unknown },
  newId: () => string,
): Promise<MemberPlan | Refused> {
  const company = await ports.companies.company(scope, raw.companyId);
  if (!company) return refuse('No such company.');
  if (TERMINAL_COMPANY(company.status))
    return refuse(`${company.name} is ${company.status}: it takes no members.`);
  const list = companyMembersInput.safeParse(raw.members);
  if (!list.success) return refuse(firstIssue(list.error));
  const members = list.data;
  const emails = members.map((m) => normalizeMemberEmail(m.email));
  const dup = emails.find((e, i) => emails.indexOf(e) !== i);
  if (dup) return refuse(`${dup} is listed twice.`);

  const teamIds = new Set(
    (await ports.companies.teams(scope, company.customerId)).map((t) => t.id),
  );
  const missing = members.find((m) => m.teamId && !teamIds.has(m.teamId));
  if (missing) return refuse(`${company.name} has no team ${missing.teamId}.`);

  const held = new Map(
    (await ports.companies.membersByEmail(scope, company.customerId, emails))
      .filter((m) => m.status !== 'removed')
      .map((m) => [m.email, m]),
  );
  const writes: MemberWrite[] = [];
  const moves: MemberPlan['moves'] = [];
  let added = 0;
  let edited = 0;
  for (const [i, m] of members.entries()) {
    const email = emails[i]!;
    const was = held.get(email);
    if (!was) {
      const status = m.status ?? 'invited';
      if (!(MEMBER_START_STATUSES as readonly string[]).includes(status))
        return refuse(`${email} can’t be added as ${status}: add them, then pause them.`);
      added++;
      writes.push({
        id: newId(),
        name: m.name,
        email,
        role: m.role ?? DEFAULT_COMPANY_ROLE,
        teamId: m.teamId ?? null,
        status: status as MemberStatus,
        orderLimit: m.orderLimit ?? null,
      });
      continue;
    }
    const moved = !!m.status && m.status !== was.status;
    if (m.status && moved) {
      if (!MEMBER_LIFECYCLE.can(was.status, m.status))
        return refuse(`${email} is ${was.status}: they can’t become ${m.status}.`);
      moves.push({ id: was.id, from: was.status, to: m.status });
    }
    const write: MemberWrite = {
      id: was.id,
      name: m.name,
      email,
      role: m.role ?? was.role,
      teamId: m.teamId === undefined ? was.teamId : m.teamId,
      status: was.status,
      orderLimit: m.orderLimit === undefined ? was.orderLimit : m.orderLimit,
    };
    const same =
      write.name === was.name &&
      write.role === was.role &&
      write.teamId === was.teamId &&
      write.orderLimit === was.orderLimit;
    if (!same || moved) edited++;
    if (!same) writes.push(write);
  }
  if (added) {
    const total = (
      await ports.companies.members(scope, { companyId: company.customerId, limit: 1 })
    ).total;
    if (total + added > MAX_COMPANY_MEMBERS)
      return refuse(`A company holds at most ${MAX_COMPANY_MEMBERS} members.`);
  }
  return {
    ok: true,
    company,
    writes,
    moves,
    added,
    edited,
  };
}

/**
 * Adds members by email and changes those already there. A repeat of the same call changes
 * nothing. A member's move (to active, to inactive) is a guarded move on the status read.
 */
export async function addMembers(
  ports: CompanyPorts,
  scope: CompanyScope,
  raw: { companyId: string; members: unknown },
  now: number,
  newId: () => string,
): Promise<CompanyChange<{ company: CompanyRecord; added: number; edited: number }>> {
  const plan = await planMembers(ports, scope, raw, newId);
  if (!plan.ok) return plan;
  const { company, added, edited } = plan;
  if (plan.writes.length) await ports.companies.upsertMembers(company.customerId, plan.writes, now);
  for (const m of plan.moves)
    if (
      !(await ports.companies.transitionMember(scope, company.customerId, m.id, m.from, m.to, now))
    )
      return refuse('A member changed meanwhile: look again.');
  if (!added && !edited) return { ok: true, changed: false, company, added, edited, audit: null };
  return {
    ok: true,
    changed: true,
    company,
    added,
    edited,
    audit: {
      action: 'company.members_saved',
      target: company.customerId,
      // How many, never who: a member's name and email are personal data.
      detail: { added, edited },
    },
  };
}

export async function planRemoveMember(
  ports: CompanyPorts,
  scope: CompanyScope,
  input: { companyId: string; memberId: string },
) {
  const company = await ports.companies.company(scope, input.companyId);
  if (!company) return refuse('No such company.');
  const member = await ports.companies.member(scope, input.companyId, input.memberId);
  if (!member) return refuse('No such member.');
  return { ok: true as const, company, member, noop: member.status === 'removed' };
}

/** Removes a member for good: their row stays, for the orders they placed. */
export async function removeMember(
  ports: CompanyPorts,
  scope: CompanyScope,
  input: { companyId: string; memberId: string },
  now: number,
): Promise<CompanyChange<{ company: CompanyRecord }>> {
  const plan = await planRemoveMember(ports, scope, input);
  if (!plan.ok) return plan;
  const { company, member } = plan;
  if (plan.noop) return { ok: true, changed: false, company, audit: null };
  if (
    !(await ports.companies.transitionMember(
      scope,
      company.customerId,
      member.id,
      member.status,
      'removed',
      now,
    ))
  ) {
    const again = await ports.companies.member(scope, company.customerId, member.id);
    if (again?.status === 'removed') return { ok: true, changed: false, company, audit: null };
    return refuse('The member changed meanwhile: look again.');
  }
  return {
    ok: true,
    changed: true,
    company,
    audit: {
      action: 'company.member_removed',
      target: company.customerId,
      detail: { member: member.id },
    },
  };
}

// ── Teams ──────────────────────────────────────────────────────────────────

export type TeamPlan = { ok: true; company: CompanyRecord; team: CompanyTeam; added: boolean };

/** What adding or moving a team would do, or why not. */
export async function planTeam(
  ports: CompanyPorts,
  scope: CompanyScope,
  raw: unknown,
  newId: () => string,
): Promise<TeamPlan | Refused> {
  const parsed = companyTeamInput.safeParse(raw);
  if (!parsed.success) return refuse(firstIssue(parsed.error));
  const input = parsed.data;
  const company = await ports.companies.company(scope, input.companyId);
  if (!company) return refuse('No such company.');
  if (TERMINAL_COMPANY(company.status))
    return refuse(`${company.name} is ${company.status}: its teams are no longer changed.`);
  const teams = await ports.companies.teams(scope, company.customerId);
  const held = input.teamId ? teams.find((t) => t.id === input.teamId) : undefined;
  if (input.teamId && !held) return refuse('No such team.');
  const parent = input.parentTeamId ? teams.find((t) => t.id === input.parentTeamId) : undefined;
  if (input.parentTeamId && !parent) return refuse('No such parent team.');
  if (held && parent && (parent.id === held.id || parent.path.startsWith(held.path)))
    return refuse('A team can’t sit under itself or one of its own teams.');
  if (!held && teams.length >= MAX_COMPANY_TEAMS)
    return refuse(`A company holds at most ${MAX_COMPANY_TEAMS} teams.`);
  const id = held?.id ?? newId();
  const path = teamPath(parent ?? null, id);
  // The deepest team in this one's subtree, as it would stand after the move.
  const below = held
    ? Math.max(
        0,
        ...teams
          .filter((t) => t.path.startsWith(held.path))
          .map((t) => teamDepth(t.path) - teamDepth(held.path)),
      )
    : 0;
  if (teamDepth(path) + below > MAX_TEAM_DEPTH)
    return refuse(`Teams nest at most ${MAX_TEAM_DEPTH} deep.`);
  const sibling = teams.find(
    (t) =>
      t.id !== id &&
      (t.parentId ?? null) === (parent?.id ?? null) &&
      t.name.toLowerCase() === input.name.toLowerCase(),
  );
  if (sibling) return refuse(`There is already a team called ${sibling.name} there.`);
  return {
    ok: true,
    company,
    added: !held,
    team: {
      id,
      companyId: company.customerId,
      parentId: parent?.id ?? null,
      name: input.name,
      path,
    },
  };
}

export async function putTeam(
  ports: CompanyPorts,
  scope: CompanyScope,
  raw: unknown,
  newId: () => string,
): Promise<CompanyChange<{ company: CompanyRecord; team: CompanyTeam }>> {
  const plan = await planTeam(ports, scope, raw, newId);
  if (!plan.ok) return plan;
  const { company, team } = plan;
  const was = plan.added
    ? undefined
    : (await ports.companies.teams(scope, company.customerId)).find((t) => t.id === team.id);
  if (was && was.name === team.name && was.path === team.path)
    return { ok: true, changed: false, company, team, audit: null };
  await ports.companies.putTeam(team);
  return {
    ok: true,
    changed: true,
    company,
    team,
    audit: {
      action: 'company.team_saved',
      target: company.customerId,
      detail: { team: team.id, ...(plan.added ? { added: true } : {}) },
    },
  };
}
