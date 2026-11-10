/**
 * Companies: a business customer's company, its teams and members, and creating and editing the
 * customer accounts they hang off. `d1CompanyDirectory` (packages/db) and `InMemoryCompanyDirectory`
 * (packages/test-kit) implement it, held to one contract.
 *
 * Every read takes a `scope`: one company's (`{ companyId }`) or everything (`{ all: true }`), so
 * a caller bound to a company cannot read another's by forgetting a filter. Lists are keyset
 * paged (the cursor is the last row's name and id) with the total the filters match. A status
 * moves only by a guarded compare-and-set on the status the caller read: of two racing moves from
 * the same state, one wins and the other is told so.
 */
import type {
  Company,
  CompanyCursor,
  CompanyMember,
  CompanyRole,
  CompanyStatus,
  CompanyTeam,
  MemberStatus,
} from '@commerceworker/core';
import type { CustomerRecord } from './pricing';

export type CompanyScope = { readonly companyId: string } | { readonly all: true };

/** A company with its customer's account fields, which the lists show and sort by. */
export interface CompanyRecord extends Company {
  /** The customer's name: what the company is called in lists. */
  readonly name: string;
  readonly email: string;
  readonly tier: string;
}

export interface CompanyPage<T> {
  readonly rows: T[];
  /** Every row the filters match, not just this page. */
  readonly total: number;
  /** Pass it as `after` for the next page; null on the last. */
  readonly next: CompanyCursor | null;
}

export interface CompanyQuery {
  readonly status?: CompanyStatus;
  /** Part of the name, legal name or id, matched literally and without regard to case. */
  readonly search?: string;
  readonly after?: CompanyCursor;
  readonly limit: number;
}

export interface MemberQuery {
  /** Narrows to one company; a company-scoped read can't widen past its own. */
  readonly companyId?: string;
  readonly status?: MemberStatus;
  readonly role?: CompanyRole;
  readonly teamId?: string;
  readonly after?: CompanyCursor;
  readonly limit: number;
}

/** A customer account as created: a balance and credit limit start at nothing. */
export interface NewCustomer {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly kind: string;
  readonly tier: string;
  readonly terms: string;
}

/** The account fields staff change; the credit limit isn't one. */
export interface CustomerPatch {
  readonly name?: string;
  readonly email?: string;
  readonly kind?: string;
  readonly tier?: string;
  readonly terms?: string;
}

/**
 * A member to write. A row for an email not yet a member of the company is added with `status`;
 * one already there keeps its id, status and creation time and takes the rest.
 */
export interface MemberWrite {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: CompanyRole;
  readonly teamId: string | null;
  readonly status: MemberStatus;
  readonly orderLimit: number | null;
}

export interface CompanyDirectory {
  /** A customer the scope can see. */
  customer(scope: CompanyScope, id: string): Promise<CustomerRecord | undefined>;
  /** The customer with this email (any case), if the scope can see it. */
  customerByEmail(scope: CompanyScope, email: string): Promise<CustomerRecord | undefined>;
  /** Companies by name then id. */
  companies(scope: CompanyScope, query: CompanyQuery): Promise<CompanyPage<CompanyRecord>>;
  company(scope: CompanyScope, customerId: string): Promise<CompanyRecord | undefined>;
  /**
   * The ids above a company, nearest first, following `parentCompanyId` while the scope can see
   * each; empty for a company the scope can't see.
   */
  ancestry(scope: CompanyScope, customerId: string): Promise<string[]>;
  /** A company's teams, parents before their children. */
  teams(scope: CompanyScope, companyId: string): Promise<CompanyTeam[]>;
  /** Members by name then id. */
  members(scope: CompanyScope, query: MemberQuery): Promise<CompanyPage<CompanyMember>>;
  member(
    scope: CompanyScope,
    companyId: string,
    memberId: string,
  ): Promise<CompanyMember | undefined>;
  /** The company's members with these (lower case) emails, removed ones too. */
  membersByEmail(
    scope: CompanyScope,
    companyId: string,
    emails: readonly string[],
  ): Promise<CompanyMember[]>;
  /**
   * What an order from `customerId` is held to: its company, and the member named as the buyer.
   * One round trip. The buyer is looked for within that customer's company only.
   */
  access(
    scope: CompanyScope,
    customerId: string,
    buyerId?: string,
  ): Promise<{ company?: CompanyRecord; buyer?: CompanyMember }>;

  /** Adds a customer (and its company, for a business one); false, nothing written, when the id is taken. */
  createCustomer(customer: NewCustomer, company: Company | null): Promise<boolean>;
  /** Changes a customer's account fields; false when there is no such customer. */
  updateCustomer(id: string, patch: CustomerPatch): Promise<boolean>;
  /** Adds a company for an existing customer; false when it already has one. */
  createCompany(company: Company): Promise<boolean>;
  /** `from` → `to`, only if the company is still in `from`. False when it wasn't (or isn't there). */
  transitionCompany(
    scope: CompanyScope,
    customerId: string,
    from: CompanyStatus,
    to: CompanyStatus,
    at: number,
  ): Promise<boolean>;
  /** Adds or changes members by email, in chunks under D1's bound-parameter limit. */
  upsertMembers(companyId: string, members: readonly MemberWrite[], at: number): Promise<void>;
  /** `from` → `to`, only if the member is still in `from`. False when they weren't. */
  transitionMember(
    scope: CompanyScope,
    companyId: string,
    memberId: string,
    from: MemberStatus,
    to: MemberStatus,
    at: number,
  ): Promise<boolean>;
  /** Adds a team, or renames and moves one, rewriting its descendants' paths with it. */
  putTeam(team: CompanyTeam): Promise<void>;
}
