import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_VARIABLES,
  accountContext,
  COMPANY_ROLES,
  companyMemberInput,
  companyMembersInput,
  companyOrderProblem,
  createCustomerInput,
  decodeCompanyCursor,
  encodeCompanyCursor,
  hasCompany,
  MAX_COMPANY_DEPTH,
  MAX_MEMBERS_PER_CALL,
  orderBuyerId,
  PROMOTION_CONDITION_VARIABLES,
  parentCompanyProblem,
  promotionConditionContext,
  promotionConditionProblem,
  teamDepth,
  teamPath,
  updateCustomerInput,
} from '../src';

describe('what an order from a company needs', () => {
  const active = { status: 'active' as const };
  const member = (over: object = {}) => ({
    companyId: 'cus_1',
    status: 'active' as const,
    ...over,
  });
  const order = (meta?: Record<string, unknown>) => ({ customerId: 'cus_1', meta });

  it('holds no customer without a company to one', () => {
    expect(companyOrderProblem(order(), { company: undefined, buyer: undefined })).toBeNull();
    expect(companyOrderProblem({ meta: {} }, { company: undefined, buyer: undefined })).toBeNull();
  });

  it('declines an order from a company that isn’t active', () => {
    for (const status of ['pending', 'suspended', 'rejected', 'closed'] as const)
      expect(companyOrderProblem(order(), { company: { status }, buyer: undefined })).toBe(
        `Company cus_1 isn't active (${status})`,
      );
    expect(companyOrderProblem(order(), { company: active, buyer: undefined })).toBeNull();
  });

  it('declines a buyer who isn’t an active member of the order’s own company', () => {
    const named = order({ buyerId: 'mem_1' });
    expect(companyOrderProblem(named, { company: active, buyer: member() })).toBeNull();
    const bad = "Buyer mem_1 isn't an active member of cus_1";
    for (const status of ['invited', 'inactive', 'removed'] as const)
      expect(companyOrderProblem(named, { company: active, buyer: member({ status }) })).toBe(bad);
    expect(companyOrderProblem(named, { company: active, buyer: undefined })).toBe(bad);
    // A member of another company is not this one's.
    expect(
      companyOrderProblem(named, { company: active, buyer: member({ companyId: 'cus_2' }) }),
    ).toBe(bad);
    // A buyer on an order whose customer has no company.
    expect(companyOrderProblem(named, { company: undefined, buyer: undefined })).toBe(bad);
    expect(
      companyOrderProblem({ meta: { buyerId: 'mem_1' } }, { company: undefined, buyer: undefined }),
    ).toBe("Buyer mem_1 isn't an active member of this order’s customer");
  });

  it('reads a buyer id only when it is a non-empty string', () => {
    expect(orderBuyerId({ buyerId: 'mem_1' })).toBe('mem_1');
    expect(orderBuyerId({ buyerId: '' })).toBeUndefined();
    expect(orderBuyerId({ buyerId: 4 })).toBeUndefined();
    expect(orderBuyerId(undefined)).toBeUndefined();
    for (const buyerId of ['', 4, null])
      expect(companyOrderProblem(order({ buyerId }), { company: active, buyer: member() })).toBe(
        'meta.buyerId must be a company member’s id',
      );
  });
});

describe('what flows and promotions read', () => {
  it('is null for no company and no buyer, as customer.* is for a guest', () => {
    expect(accountContext(undefined, undefined, undefined)).toEqual({
      company: { status: null, tier: null },
      buyer: { role: null, team: null, orderLimit: null },
    });
  });

  it('carries the company’s status and tier, and the member’s role, team and limit', () => {
    expect(
      accountContext(
        { tier: 'gold' },
        { status: 'suspended' },
        { role: 'approver', teamId: 'team_1', orderLimit: 250 },
      ),
    ).toEqual({
      company: { status: 'suspended', tier: 'gold' },
      buyer: { role: 'approver', team: 'team_1', orderLimit: 250 },
    });
  });

  it('is in a promotion condition’s variables, and the documented list is the allowed one', () => {
    for (const name of Object.keys(ACCOUNT_VARIABLES)) {
      expect(PROMOTION_CONDITION_VARIABLES).toHaveProperty(name);
      expect(promotionConditionProblem({ '==': [{ var: name }, null] })).toBeNull();
    }
    expect(promotionConditionProblem({ var: 'buyer.email' })).toMatch(/buyer\.email/);
    const c = promotionConditionContext({
      now: 0,
      currency: 'USD',
      fxRate: 1,
      channel: 'web',
      lines: [],
      customerId: 'c',
      customer: { kind: 'business', tier: 'gold' },
      meta: {},
      account: accountContext(
        { tier: 'gold' },
        { status: 'active' },
        { role: 'buyer', teamId: null, orderLimit: null },
      ),
    });
    expect(c.company).toEqual({ status: 'active', tier: 'gold' });
    expect(c.buyer).toEqual({ role: 'buyer', team: null, orderLimit: null });
  });
});

describe('what a caller may write', () => {
  it('takes a member by email, name and the fixed roles', () => {
    expect(companyMemberInput.safeParse({ email: 'a@b.test', name: 'A' }).success).toBe(true);
    for (const role of COMPANY_ROLES)
      expect(companyMemberInput.safeParse({ email: 'a@b.test', name: 'A', role }).success).toBe(
        true,
      );
    for (const bad of [
      { email: 'nope', name: 'A' },
      { email: 'a@b.test', name: ' ' },
      { email: 'a@b.test', name: 'A', role: 'owner' },
      { email: 'a@b.test', name: 'A', orderLimit: -5 },
      { email: 'a@b.test', name: 'A', status: 'removed' },
    ])
      expect(companyMemberInput.safeParse(bad).success).toBe(false);
  });

  it('takes up to a call’s worth of members', () => {
    const m = { email: 'a@b.test', name: 'A' };
    expect(companyMembersInput.safeParse([]).success).toBe(false);
    expect(companyMembersInput.safeParse(Array(MAX_MEMBERS_PER_CALL).fill(m)).success).toBe(true);
    expect(companyMembersInput.safeParse(Array(MAX_MEMBERS_PER_CALL + 1).fill(m)).success).toBe(
      false,
    );
  });

  it('defaults a new customer to a standard business account on net 30', () => {
    expect(createCustomerInput.parse({ name: 'Acme', email: 'a@acme.test' })).toEqual({
      name: 'Acme',
      email: 'a@acme.test',
      kind: 'business',
      tier: 'standard',
      terms: 'net_30',
    });
    expect(
      createCustomerInput.safeParse({ name: 'A', email: 'a@b.test', terms: 'whenever' }).success,
    ).toBe(false);
    expect(
      createCustomerInput.safeParse({ name: 'A', email: 'a@b.test', tier: 'Gold!' }).success,
    ).toBe(false);
  });

  it('leaves the credit limit out of an update', () => {
    expect(updateCustomerInput.parse({ customerId: 'c', tier: 'gold', creditLimit: 99 })).toEqual({
      customerId: 'c',
      tier: 'gold',
    });
  });

  it('knows only business customers have a company', () => {
    expect(hasCompany('business')).toBe(true);
    expect(hasCompany('consumer')).toBe(false);
    expect(hasCompany('internal')).toBe(false);
  });
});

describe('teams and companies in trees', () => {
  it('writes a team’s path under its parent’s', () => {
    const root = { path: teamPath(null, 'a') };
    expect(root.path).toBe('/a/');
    expect(teamPath(root, 'b')).toBe('/a/b/');
    expect(teamDepth('/a/b/c/')).toBe(3);
  });

  it('refuses a company as its own parent, a loop and a tree too deep', () => {
    expect(parentCompanyProblem('a', 'a', ['a'])).toMatch(/own parent/);
    expect(parentCompanyProblem('a', 'b', ['b', 'a'])).toMatch(/own ancestor/);
    expect(
      parentCompanyProblem(
        'a',
        'b',
        Array.from({ length: MAX_COMPANY_DEPTH }, (_, i) => `p${i}`),
      ),
    ).toMatch(/at most/);
    expect(parentCompanyProblem('a', 'b', ['b', 'c'])).toBeNull();
  });

  it('round-trips a cursor and rejects anything else', () => {
    const c = { name: 'Zoë “Z” 100%', id: 'cus_1' };
    expect(decodeCompanyCursor(encodeCompanyCursor(c))).toEqual(c);
    for (const junk of ['', 'abc', '!!!', btoa('[1,2]'), btoa('{"a":1}')])
      expect(decodeCompanyCursor(junk)).toBeUndefined();
  });
});
