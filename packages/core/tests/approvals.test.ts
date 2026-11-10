import { describe, expect, it } from 'vitest';
import {
  type ApprovalPlan,
  type ApprovalSpec,
  approvalConfigErrors,
  approvalsRequired,
  approvalWaitingFor,
  approversLabel,
  type CompanyMember,
  eligibleApprovers,
  evaluateApprovalStatus,
  parseApprovers,
  readApprovalSpec,
  validateConfig,
  voteProblem,
  withDefaults,
} from '../src';

const spec = (over: Partial<ApprovalSpec> = {}): ApprovalSpec => ({
  approvers: { kind: 'company', role: 'approver' },
  mode: 'any',
  quorum: null,
  majorityPercent: 50,
  ...over,
});
const yes = (voterId: string) => ({ voterId, decision: 'approved' });
const no = (voterId: string) => ({ voterId, decision: 'rejected' });
const status = (s: ApprovalSpec, eligible: string[] | null, ...votes: ReturnType<typeof yes>[]) =>
  evaluateApprovalStatus(s, eligible, votes);

describe('reading approvers', () => {
  it('reads each form', () => {
    expect(parseApprovers('staff:operator')).toEqual({ rule: { kind: 'staff', role: 'operator' } });
    expect(parseApprovers(' company:company_admin ')).toEqual({
      rule: { kind: 'company', role: 'company_admin' },
    });
    expect(parseApprovers('team:team_ops')).toEqual({ rule: { kind: 'team', teamId: 'team_ops' } });
    expect(parseApprovers('members:mem_a, mem_b,mem_a')).toEqual({
      rule: { kind: 'members', ids: ['mem_a', 'mem_b'] },
    });
  });

  it('says what is wrong, in the editor’s words', () => {
    for (const bad of [
      '',
      'staff',
      'staff:boss',
      'company:viewer',
      'team:',
      'members:',
      'x:y',
      4,
    ]) {
      expect(parseApprovers(bad), String(bad)).toHaveProperty('error');
    }
    const many = `members:${Array.from({ length: 51 }, (_, i) => `m${i}`).join(',')}`;
    expect(parseApprovers(many)).toEqual({ error: expect.stringContaining('at most 50') });
  });

  it('defaults to today’s approvers: any one staff approver', () => {
    expect(readApprovalSpec({})).toEqual({
      spec: {
        approvers: { kind: 'staff', role: 'approver' },
        mode: 'any',
        quorum: null,
        majorityPercent: 50,
      },
    });
    expect(withDefaults('control.approval', {})).toMatchObject({
      approvers: 'staff:approver',
      mode: 'any',
    });
    expect(validateConfig('control.approval', {})).toEqual([]);
  });

  it('holds the node’s fields to what a mode needs', () => {
    expect(approvalConfigErrors({ mode: 'quorum' })).toEqual([
      'Quorum is a whole number of at least 1',
    ]);
    expect(approvalConfigErrors({ mode: 'quorum', quorum: 2 })).toEqual([]);
    expect(approvalConfigErrors({ mode: 'quorum', quorum: 2.5 })).toHaveLength(1);
    expect(approvalConfigErrors({ approvers: 'members:a,b', mode: 'quorum', quorum: 3 })).toEqual([
      'Quorum 3 is more than the 2 members named',
    ]);
    expect(approvalConfigErrors({ mode: 'majority', majorityPercent: 100 })).toHaveLength(1);
    expect(approvalConfigErrors({ mode: 'majority', majorityPercent: 0 })).toHaveLength(1);
    expect(approvalConfigErrors({ mode: 'majority', majorityPercent: 99 })).toEqual([]);
    expect(approvalConfigErrors({ mode: 'most' })).toHaveLength(1);
    expect(validateConfig('control.approval', { approvers: 'company:nobody' })).toEqual([
      'company:<role> takes one of buyer, approver, company_admin',
    ]);
  });

  it('names who the approvers are', () => {
    expect(approversLabel('company:approver')).toBe('Company approvers');
    expect(approversLabel('company:company_admin')).toBe('Company company admins');
    expect(approversLabel('staff:operator')).toBe('Staff operators');
    expect(approversLabel('members:a')).toBe('A named member');
    expect(approversLabel('members:a,b')).toBe('2 named members');
    expect(approversLabel('team:t')).toBe('A team’s members');
  });

  it('keeps waiting_for as it was for staff approvers, and names the rule for the rest', () => {
    const plan = (approvers: string): ApprovalPlan => ({ approvers, mode: 'any', eligible: null });
    expect(approvalWaitingFor({ assignee: 'finance' })).toBe('person:finance');
    expect(approvalWaitingFor({ assignee: 'finance', approval: plan('staff:approver') })).toBe(
      'person:finance',
    );
    expect(approvalWaitingFor({ approval: plan('staff:admin') })).toBe('person:');
    expect(approvalWaitingFor({ assignee: 'finance', approval: plan(' company:approver ') })).toBe(
      'approvers:company:approver',
    );
  });
});

describe('evaluating a vote', () => {
  const eligible = ['a', 'b', 'c', 'd'];

  it('any: the first approval decides it', () => {
    expect(status(spec(), eligible).status).toBe('pending');
    expect(status(spec(), eligible, yes('c'))).toMatchObject({
      status: 'approved',
      label: '1 of 1',
    });
    // Open to any staff: nobody to count.
    expect(status(spec(), null, yes('whoever')).status).toBe('approved');
  });

  it('a rejection ends the vote, in every mode and whatever else was said', () => {
    for (const mode of ['any', 'all', 'majority', 'quorum'] as const) {
      const s = spec({ mode, quorum: 1 });
      expect(status(s, eligible, no('b')), mode).toMatchObject({
        status: 'rejected',
        rejections: 1,
      });
      expect(status(s, eligible, yes('a'), yes('c'), yes('d'), no('b')).status, mode).toBe(
        'rejected',
      );
    }
  });

  it('all: needs every eligible approver, by identity, not by count', () => {
    const s = spec({ mode: 'all' });
    expect(status(s, ['a', 'b'], yes('a')).status).toBe('pending');
    expect(status(s, ['a', 'b'], yes('a'), yes('b'))).toMatchObject({
      status: 'approved',
      label: '2 of 2',
    });
    // v1 compared counts: two approvals approved it, whoever they were. An outsider can't stand in
    // for an approver, nor can the same approver twice.
    expect(status(s, ['a', 'b'], yes('a'), yes('outsider')).status).toBe('pending');
    expect(status(s, ['a', 'b'], yes('a'), yes('a')).status).toBe('pending');
    expect(status(s, ['a', 'b'], yes('b'), yes('a')).status).toBe('approved');
  });

  it('majority: more than the share, not the share itself', () => {
    const s = spec({ mode: 'majority' });
    // At 50%, 2 of 4 is exactly half: not a majority. 3 of 4 is.
    expect(status(s, eligible, yes('a'), yes('b')).status).toBe('pending');
    expect(status(s, eligible, yes('a'), yes('b'), yes('c')).status).toBe('approved');
    expect(approvalsRequired(s, 4)).toBe(3);
    // Odd counts: 2 of 3 is more than half, 1 of 3 is not.
    expect(status(s, ['a', 'b', 'c'], yes('a')).status).toBe('pending');
    expect(status(s, ['a', 'b', 'c'], yes('a'), yes('b')).status).toBe('approved');
    expect(approvalsRequired(s, 3)).toBe(2);
    // One approver is the whole of it.
    expect(status(s, ['a'], yes('a')).status).toBe('approved');
  });

  it('majority: another share moves the boundary', () => {
    const s = spec({ mode: 'majority', majorityPercent: 60 });
    // 3 of 5 is exactly 60%: not more than it. 4 of 5 is.
    const five = ['a', 'b', 'c', 'd', 'e'];
    expect(status(s, five, yes('a'), yes('b'), yes('c')).status).toBe('pending');
    expect(status(s, five, yes('a'), yes('b'), yes('c'), yes('d')).status).toBe('approved');
    expect(approvalsRequired(s, 5)).toBe(4);
    expect(approvalsRequired(spec({ mode: 'majority', majorityPercent: 99 }), 100)).toBe(100);
  });

  it('quorum: its number of approvals from the eligible', () => {
    const s = spec({ mode: 'quorum', quorum: 2 });
    expect(status(s, eligible, yes('a'))).toMatchObject({ status: 'pending', label: '1 of 2' });
    expect(status(s, eligible, yes('a'), yes('d')).status).toBe('approved');
    // An outsider's approval, or the same one twice, isn't a second.
    expect(status(s, eligible, yes('a'), yes('x')).status).toBe('pending');
    expect(status(s, eligible, yes('a'), yes('a')).status).toBe('pending');
  });

  it('counts a voter’s first vote only', () => {
    const t = status(spec({ mode: 'quorum', quorum: 1 }), eligible, yes('a'), no('a'));
    expect(t).toMatchObject({ status: 'approved', approvals: 1, rejections: 0 });
  });

  it('can’t approve with nobody eligible: it waits for the step to time out', () => {
    for (const mode of ['all', 'majority', 'quorum'] as const) {
      expect(status(spec({ mode, quorum: 1 }), [], yes('a')).status, mode).toBe('pending');
    }
    expect(status(spec({ mode: 'all' }), []).status).toBe('pending');
  });
});

describe('who is eligible', () => {
  const member = (
    id: string,
    over: Partial<Pick<CompanyMember, 'role' | 'teamId' | 'status'>> = {},
  ): Pick<CompanyMember, 'id' | 'role' | 'teamId' | 'status'> => ({
    id,
    role: 'buyer',
    teamId: null,
    status: 'active',
    ...over,
  });
  const members = [
    member('ann', { role: 'approver', teamId: 'ops' }),
    member('bo', { role: 'approver', teamId: 'ops-east' }),
    member('cy', { role: 'approver', status: 'inactive' }),
    member('di', { role: 'company_admin' }),
    member('ed', { role: 'buyer', teamId: 'ops' }),
  ];
  const teams = [
    { id: 'ops', path: '/ops/' },
    { id: 'ops-east', path: '/ops/ops-east/' },
    { id: 'other', path: '/other/' },
  ];
  const active = { status: 'active' };
  const rule = (approvers: ApprovalSpec['approvers']) => spec({ approvers });

  it('company: active members in the role', () => {
    expect(eligibleApprovers(rule({ kind: 'company', role: 'approver' }), active, members)).toEqual(
      ['ann', 'bo'],
    );
    expect(
      eligibleApprovers(rule({ kind: 'company', role: 'company_admin' }), active, members),
    ).toEqual(['di']);
  });

  it('team: the team’s members, and those of the teams under it', () => {
    expect(
      eligibleApprovers(rule({ kind: 'team', teamId: 'ops' }), active, members, { teams }),
    ).toEqual(['ann', 'bo', 'ed']);
    expect(
      eligibleApprovers(rule({ kind: 'team', teamId: 'ops-east' }), active, members, { teams }),
    ).toEqual(['bo']);
    // Without the teams to read a subtree from: the team itself.
    expect(eligibleApprovers(rule({ kind: 'team', teamId: 'ops' }), active, members)).toEqual([
      'ann',
      'ed',
    ]);
  });

  it('members: the named ones who are active members', () => {
    expect(
      eligibleApprovers(
        rule({ kind: 'members', ids: ['ed', 'cy', 'ghost', 'di'] }),
        active,
        members,
      ),
    ).toEqual(['di', 'ed']);
  });

  it('nobody, when there is no company or it isn’t active', () => {
    const r = rule({ kind: 'company', role: 'approver' });
    expect(eligibleApprovers(r, undefined, members)).toEqual([]);
    expect(eligibleApprovers(r, null, members)).toEqual([]);
    expect(eligibleApprovers(r, { status: 'suspended' }, members)).toEqual([]);
  });

  it('staff: the people with the role or higher who aren’t disabled', () => {
    const staff = [
      { id: 'u1', role: 'viewer' },
      { id: 'u2', role: 'approver' },
      { id: 'u3', role: 'admin' },
      { id: 'u4', role: 'operator', disabledAt: 5 },
      { id: 'u5', role: 'operator', disabledAt: null },
    ];
    expect(
      eligibleApprovers(rule({ kind: 'staff', role: 'approver' }), undefined, [], { staff }),
    ).toEqual(['u2', 'u3', 'u5']);
    expect(
      eligibleApprovers(rule({ kind: 'staff', role: 'operator' }), undefined, [], { staff }),
    ).toEqual(['u3', 'u5']);
  });
});

describe('whether a vote is allowed', () => {
  const plan = (over: Partial<ApprovalPlan> = {}): ApprovalPlan => ({
    approvers: 'company:approver',
    mode: 'quorum',
    quorum: 2,
    companyId: 'cus_co',
    eligible: ['ann', 'bo', 'cy'],
    ...over,
  });
  const check = (over: Partial<Parameters<typeof voteProblem>[0]> = {}) =>
    voteProblem({
      plan: plan(),
      votes: [],
      voter: { id: 'ann', kind: 'member' },
      separation: true,
      companyStatus: 'active',
      ...over,
    });

  it('allows an eligible member of an active company', () => {
    expect(check()).toBeNull();
  });

  it('refuses someone who isn’t one of the approvers', () => {
    expect(check({ voter: { id: 'dee', kind: 'member' } })).toMatch(
      /isn’t one of this approval’s approvers/,
    );
  });

  it('refuses a second vote from the same voter', () => {
    expect(check({ votes: [yes('ann')] })).toBe('This person has already voted.');
    expect(check({ votes: [yes('bo')] })).toBeNull();
  });

  it('refuses a vote once it is decided', () => {
    expect(check({ votes: [yes('bo'), yes('cy')], voter: { id: 'ann', kind: 'member' } })).toBe(
      'That approval is already decided.',
    );
    expect(check({ votes: [no('bo')] })).toBe('That approval is already decided.');
  });

  it('refuses a buyer deciding their own order, as separation does for staff', () => {
    expect(check({ buyerId: 'ann' })).toBe('A buyer can’t decide their own order.');
    expect(check({ buyerId: 'ann', separation: false })).toBeNull();
    expect(check({ buyerId: 'bo' })).toBeNull();
  });

  it('refuses when the company isn’t active', () => {
    expect(check({ companyStatus: 'suspended' })).toBe(
      'The company isn’t active, so its members can’t vote.',
    );
    expect(check({ companyStatus: undefined })).toMatch(/isn’t active/);
  });

  it('sends staff to onBehalfOf on a company approval', () => {
    expect(check({ voter: { id: 'usr_1', kind: 'staff', role: 'admin' } })).toMatch(/onBehalfOf/);
  });

  it('holds a staff approval to staff, and to its role', () => {
    const staffPlan = plan({ approvers: 'staff:operator', mode: 'any', eligible: null });
    const as = (role: 'approver' | 'operator', kind: 'staff' | 'member' = 'staff') =>
      check({ plan: staffPlan, voter: { id: 'usr_1', kind, role } });
    expect(as('operator')).toBeNull();
    expect(as('approver')).toBe('This approval needs the operator role.');
    expect(as('operator', 'member')).toBe(
      'This approval is decided by staff, not a company’s members.',
    );
  });

  it('holds a counted staff approval to the people it counted', () => {
    const counted = plan({
      approvers: 'staff:approver',
      mode: 'all',
      eligible: ['usr_1', 'usr_2'],
    });
    expect(
      check({ plan: counted, voter: { id: 'usr_1', kind: 'staff', role: 'admin' } }),
    ).toBeNull();
    expect(check({ plan: counted, voter: { id: 'tok_x', kind: 'staff', role: 'admin' } })).toMatch(
      /isn’t one of/,
    );
  });
});
