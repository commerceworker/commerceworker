/**
 * The companies port in memory, seeded from a fixture. The contract in
 * ./company-directory-contract.ts holds it to the same behaviour as the D1 store (packages/db),
 * so use-case tests on it mean what they say about production.
 */
import type {
  Company,
  CompanyCursor,
  CompanyMember,
  CompanyStatus,
  CompanyTeam,
  MemberStatus,
} from '@commerceworker/core';
import type {
  CompanyDirectory,
  CompanyPage,
  CompanyRecord,
  CompanyScope,
  CustomerPatch,
  CustomerRecord,
  MemberQuery,
  MemberWrite,
  NewCustomer,
} from '@commerceworker/ports/commerce';

/** What a directory holds, as a test seeds it. */
export interface CompanyFixture {
  customers?: CustomerRecord[];
  companies?: Company[];
  teams?: CompanyTeam[];
  members?: CompanyMember[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const after = (c: CompanyCursor | undefined, name: string, id: string) =>
  !c || cmp(name, c.name) > 0 || (name === c.name && cmp(id, c.id) > 0);

/** Rows already in order and filtered: the page after the cursor, and the total. */
function paged<T>(
  rows: T[],
  key: (r: T) => CompanyCursor,
  cursor: CompanyCursor | undefined,
  limit: number,
): CompanyPage<T> {
  const rest = rows.filter((r) => {
    const k = key(r);
    return after(cursor, k.name, k.id);
  });
  const shown = rest.slice(0, limit);
  return {
    rows: shown.map((r) => structuredClone(r)),
    total: rows.length,
    next: rest.length > limit ? key(shown.at(-1)!) : null,
  };
}

const sees = (scope: CompanyScope, companyId: string) =>
  'all' in scope || scope.companyId === companyId;

export class InMemoryCompanyDirectory implements CompanyDirectory {
  private readonly customers: CustomerRecord[];
  private readonly companyRows: Company[];
  private readonly teamRows: CompanyTeam[];
  private readonly memberRows: CompanyMember[];

  constructor(fixture: CompanyFixture = {}) {
    const f = structuredClone(fixture);
    this.customers = f.customers ?? [];
    this.companyRows = f.companies ?? [];
    this.teamRows = f.teams ?? [];
    this.memberRows = f.members ?? [];
  }

  private record(c: Company): CompanyRecord | undefined {
    const customer = this.customers.find((x) => x.id === c.customerId);
    return customer
      ? structuredClone({ ...c, name: customer.name, email: customer.email, tier: customer.tier })
      : undefined;
  }

  async customer(scope: CompanyScope, id: string) {
    const c = this.customers.find((x) => x.id === id);
    return c && sees(scope, id) ? structuredClone(c) : undefined;
  }

  async customerByEmail(scope: CompanyScope, email: string) {
    const c = this.customers.find(
      (x) => x.email.toLowerCase() === email.toLowerCase() && sees(scope, x.id),
    );
    return c ? structuredClone(c) : undefined;
  }

  async companies(scope: CompanyScope, q: Parameters<CompanyDirectory['companies']>[1]) {
    const needle = q.search?.toLowerCase();
    const rows = this.companyRows
      .filter((c) => sees(scope, c.customerId) && (!q.status || c.status === q.status))
      .flatMap((c) => this.record(c) ?? [])
      .filter(
        (c) =>
          !needle ||
          [c.name, c.legalName, c.customerId].some((v) => v.toLowerCase().includes(needle)),
      )
      .sort((a, b) => cmp(a.name, b.name) || cmp(a.customerId, b.customerId));
    return paged(rows, (c) => ({ name: c.name, id: c.customerId }), q.after, q.limit);
  }

  async company(scope: CompanyScope, customerId: string) {
    const c = this.companyRows.find((x) => x.customerId === customerId);
    return c && sees(scope, customerId) ? this.record(c) : undefined;
  }

  async companiesById(scope: CompanyScope, ids: readonly string[]) {
    return this.companyRows
      .filter((c) => ids.includes(c.customerId) && sees(scope, c.customerId))
      .flatMap((c) => this.record(c) ?? [])
      .sort((a, b) => cmp(a.name, b.name) || cmp(a.customerId, b.customerId));
  }

  async ancestry(scope: CompanyScope, customerId: string) {
    const out: string[] = [];
    let cur = this.companyRows.find((c) => c.customerId === customerId);
    if (!cur || !sees(scope, customerId)) return out;
    while (cur?.parentCompanyId && !out.includes(cur.parentCompanyId)) {
      const parent: Company | undefined = this.companyRows.find(
        (c) => c.customerId === cur?.parentCompanyId,
      );
      if (!parent || !sees(scope, parent.customerId)) break;
      out.push(parent.customerId);
      cur = parent;
    }
    return out;
  }

  async teams(scope: CompanyScope, companyId: string) {
    if (!sees(scope, companyId)) return [];
    return this.teamRows
      .filter((t) => t.companyId === companyId)
      .sort((a, b) => cmp(a.path, b.path))
      .map((t) => structuredClone(t));
  }

  async members(scope: CompanyScope, q: MemberQuery) {
    const rows = this.memberRows
      .filter(
        (m) =>
          sees(scope, m.companyId) &&
          (!q.companyId || m.companyId === q.companyId) &&
          (!q.status || m.status === q.status) &&
          (!q.role || m.role === q.role) &&
          (!q.teamId || m.teamId === q.teamId),
      )
      .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
    return paged(rows, (m) => ({ name: m.name, id: m.id }), q.after, q.limit);
  }

  async member(scope: CompanyScope, companyId: string, memberId: string) {
    const m = this.memberRows.find((x) => x.id === memberId && x.companyId === companyId);
    return m && sees(scope, companyId) ? structuredClone(m) : undefined;
  }

  async membersByEmail(scope: CompanyScope, companyId: string, emails: readonly string[]) {
    if (!sees(scope, companyId)) return [];
    const want = new Set(emails.map((e) => e.toLowerCase()));
    return this.memberRows
      .filter((m) => m.companyId === companyId && want.has(m.email.toLowerCase()))
      .map((m) => structuredClone(m));
  }

  async access(scope: CompanyScope, customerId: string, buyerId?: string) {
    const company = await this.company(scope, customerId);
    const buyer = buyerId ? await this.member(scope, customerId, buyerId) : undefined;
    return { ...(company ? { company } : {}), ...(buyer ? { buyer } : {}) };
  }

  async createCustomer(c: NewCustomer, company: Company | null) {
    if (this.customers.some((x) => x.id === c.id)) return false;
    this.customers.push({
      ...c,
      creditLimit: 0,
      balance: 0,
      stripeCustomerId: null,
      stripePaymentMethodId: null,
    });
    if (company && !this.companyRows.some((x) => x.customerId === company.customerId))
      this.companyRows.push(structuredClone(company));
    return true;
  }

  async updateCustomer(id: string, patch: CustomerPatch) {
    const c = this.customers.find((x) => x.id === id);
    if (!c) return false;
    Object.assign(c, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    return true;
  }

  async createCompany(company: Company) {
    if (this.companyRows.some((x) => x.customerId === company.customerId)) return false;
    this.companyRows.push(structuredClone(company));
    return true;
  }

  async transitionCompany(
    scope: CompanyScope,
    customerId: string,
    from: CompanyStatus,
    to: CompanyStatus,
    at: number,
  ) {
    const c = this.companyRows.find((x) => x.customerId === customerId);
    if (!c || c.status !== from || !sees(scope, customerId)) return false;
    Object.assign(c, { status: to, updatedAt: at });
    return true;
  }

  async upsertMembers(companyId: string, members: readonly MemberWrite[], at: number) {
    for (const w of members) {
      const email = w.email.toLowerCase();
      const held = this.memberRows.find(
        (m) =>
          m.companyId === companyId && m.email.toLowerCase() === email && m.status !== 'removed',
      );
      if (held)
        Object.assign(held, {
          name: w.name,
          role: w.role,
          teamId: w.teamId,
          orderLimit: w.orderLimit,
          updatedAt: at,
        });
      else
        this.memberRows.push({
          id: w.id,
          companyId,
          name: w.name,
          email,
          role: w.role,
          teamId: w.teamId,
          status: w.status,
          orderLimit: w.orderLimit,
          createdAt: at,
          updatedAt: at,
        });
    }
  }

  async transitionMember(
    scope: CompanyScope,
    companyId: string,
    memberId: string,
    from: MemberStatus,
    to: MemberStatus,
    at: number,
  ) {
    const m = this.memberRows.find((x) => x.id === memberId && x.companyId === companyId);
    if (!m || m.status !== from || !sees(scope, companyId)) return false;
    Object.assign(m, { status: to, updatedAt: at });
    return true;
  }

  async putTeam(team: CompanyTeam) {
    const held = this.teamRows.find((t) => t.id === team.id);
    if (!held) {
      this.teamRows.push(structuredClone(team));
      return;
    }
    const was = held.path;
    for (const t of this.teamRows)
      if (t.companyId === held.companyId && t.id !== held.id && t.path.startsWith(was))
        t.path = team.path + t.path.slice(was.length);
    Object.assign(held, { name: team.name, parentId: team.parentId, path: team.path });
  }
}
