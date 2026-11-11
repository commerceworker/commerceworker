import { APPROVAL_SEPARATION_KEY, type Company, type CompanyMember } from '@commerceworker/core';
import {
  InMemoryCompanyDirectory,
  InMemoryOrderRecords,
  InMemoryWorkspaceStore,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  type ApprovalPorts,
  castApprovalVote,
  plainPlan,
  planApproval,
  planRequired,
  tallyWith,
  voteRefusal,
  voterOf,
} from '../src/commerce';

const company = (over: Partial<Company> = {}): Company => ({
  customerId: 'acme',
  status: 'active',
  legalName: 'Acme Ltd',
  taxId: null,
  parentCompanyId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const member = (id: string, over: Partial<CompanyMember> = {}): CompanyMember => ({
  id,
  companyId: 'acme',
  name: `Name ${id}`,
  email: `${id}@acme.test`,
  role: 'approver',
  teamId: null,
  status: 'active',
  orderLimit: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const person = (id: string, role: string, disabledAt: number | null = null) => ({
  id,
  email: `${id}@shop.test`,
  name: id,
  role,
  disabledAt,
});

function setup(
  over: { company?: Company; members?: CompanyMember[]; settings?: Record<string, string> } = {},
) {
  const records = new InMemoryOrderRecords({ orders: ['ord_1'] });
  const ports: ApprovalPorts = {
    records,
    companies: new InMemoryCompanyDirectory({
      customers: [
        {
          id: 'acme',
          name: 'Acme',
          email: 'acme@example.test',
          kind: 'business',
          tier: 'standard',
          creditLimit: 0,
          balance: 0,
          terms: 'net_30',
          stripeCustomerId: null,
          stripePaymentMethodId: null,
        },
      ],
      companies: [over.company ?? company()],
      members: over.members ?? [member('m1'), member('m2'), member('m3', { role: 'buyer' })],
    }),
    workspace: new InMemoryWorkspaceStore({
      members: [person('p1', 'approver'), person('p2', 'approver'), person('p3', 'admin', 5)],
      ...(over.settings ? { settings: over.settings } : {}),
    }),
  };
  return { ports, records };
}

const open = (records: InMemoryOrderRecords) =>
  records.openApproval({
    id: 'apr_1',
    orderId: 'ord_1',
    nodeId: 'gate',
    eventType: 'approval:gate#1',
    title: 'Approve',
    assignee: 'x',
    amount: 100,
  });
const cast = (
  ports: ApprovalPorts,
  plan: Awaited<ReturnType<typeof planApproval>>,
  voter: ReturnType<typeof voterOf>,
  decision: 'approved' | 'rejected' = 'approved',
  more: { onBehalfOf?: string; order?: { meta?: Record<string, unknown> } } = {},
  now = 10,
) =>
  castApprovalVote(
    ports,
    {
      orderId: 'ord_1',
      eventType: 'approval:gate#1',
      plan,
      order: (more.order ?? { meta: {} }) as never,
      voter,
      decision,
      onBehalfOf: more.onBehalfOf,
      by: 'ops',
      deciderId: 'p1',
    },
    now,
  );

describe('planApproval', () => {
  it('opens a staff approval to any staff approver, and names the default when none is written', async () => {
    const { ports } = setup();
    const plan = await planApproval(ports, {}, { customerId: 'acme' });
    expect(plan).toEqual({ approvers: 'staff:approver', mode: 'any', eligible: null });
    expect(planRequired(plan)).toBe(1);
  });

  it('counts the team’s non-disabled people only for a mode that counts', async () => {
    const { ports } = setup();
    const plan = await planApproval(
      ports,
      { approvers: 'staff:approver', mode: 'all' },
      { customerId: null },
    );
    expect(plan.eligible).toEqual(['p1', 'p2']);
    expect(planRequired(plan)).toBe(2);
  });

  it('resolves company approvers from the order’s company, active members of the role only', async () => {
    const { ports } = setup({ members: [member('m1'), member('m2', { status: 'inactive' })] });
    const plan = await planApproval(
      ports,
      { approvers: 'company:approver', mode: 'all' },
      { customerId: 'acme' },
    );
    expect(plan).toMatchObject({ companyId: 'acme', eligible: ['m1'] });
  });

  it('leaves nobody to vote when the order has no company, or it has none that exists', async () => {
    const { ports } = setup();
    const config = { approvers: 'company:approver' };
    expect((await planApproval(ports, config, { customerId: null })).eligible).toEqual([]);
    expect((await planApproval(ports, config, { customerId: 'ghost' })).eligible).toEqual([]);
  });

  it('throws on a node that bypassed the publish check', async () => {
    const { ports } = setup();
    await expect(planApproval(ports, { mode: 'nope' }, { customerId: null })).rejects.toThrow(
      /Mode takes one of/,
    );
  });
});

describe('castApprovalVote', () => {
  it('records a staff decision for an any-mode approval and reports it decided, unaudited', async () => {
    const { ports, records } = setup();
    await open(records);
    const out = await cast(ports, plainPlan(), voterOf({ id: 'p1', by: 'ops', role: 'approver' }));
    expect(out).toMatchObject({ ok: true, voted: 'ops', audited: false });
    expect(out.ok && out.tally.status).toBe('approved');
    expect(await records.votes('ord_1', 'approval:gate#1')).toMatchObject([
      { voterId: 'p1', voterKind: 'staff', onBehalfBy: null, at: 10 },
    ]);
  });

  it('records a member’s vote on behalf, names who recorded it and waits for the quorum', async () => {
    const { ports, records } = setup();
    await open(records);
    const plan = await planApproval(
      ports,
      { approvers: 'company:approver', mode: 'all' },
      { customerId: 'acme' },
    );
    const out = await cast(
      ports,
      plan,
      voterOf({ id: 'p1', by: 'ops', onBehalfOf: 'm1' }),
      'approved',
      { onBehalfOf: 'm1' },
    );
    expect(out).toMatchObject({ ok: true, voted: 'Name m1', audited: true });
    expect(out.ok && out.tally.status).toBe('pending');
    expect((await records.votes('ord_1', 'approval:gate#1'))[0]).toMatchObject({
      voterKind: 'member',
      onBehalfBy: 'p1',
    });
    const second = await cast(
      ports,
      plan,
      voterOf({ id: 'p1', by: 'ops', onBehalfOf: 'm2' }),
      'approved',
      { onBehalfOf: 'm2' },
    );
    expect(second.ok && second.tally.status).toBe('approved');
  });

  it('counts a vote sent again once, and refuses a second, different one', async () => {
    const { ports, records } = setup();
    await open(records);
    const plan = await planApproval(
      ports,
      { approvers: 'company:approver', mode: 'all' },
      { customerId: 'acme' },
    );
    const voter = voterOf({ id: 'p1', by: 'ops', onBehalfOf: 'm1' });
    const more = { onBehalfOf: 'm1' };
    await cast(ports, plan, voter, 'approved', more);
    const again = await cast(ports, plan, voter, 'approved', more);
    expect(again.ok && again.tally.label).toBe('1 of 2');
    expect(await records.votes('ord_1', 'approval:gate#1')).toHaveLength(1);
    expect(await cast(ports, plan, voter, 'rejected', more)).toEqual({
      ok: false,
      error: 'This person has already voted.',
    });
  });

  it('refuses a vote the rules refuse, and records nothing', async () => {
    const { ports, records } = setup({
      company: company({ status: 'suspended' }),
    });
    await open(records);
    const plan = {
      ...(await planApproval(ports, { approvers: 'company:approver' }, { customerId: 'acme' })),
      eligible: ['m1'],
    };
    const out = await cast(ports, plan, voterOf({ by: 'ops', onBehalfOf: 'm1' }), 'approved', {
      onBehalfOf: 'm1',
    });
    expect(out).toEqual({
      ok: false,
      error: 'The company isn’t active, so its members can’t vote.',
    });
    expect(await records.votes('ord_1', 'approval:gate#1')).toEqual([]);
  });

  it('refuses onBehalfOf on a staff approval, and staff on a company one', async () => {
    const { ports } = setup();
    expect(
      await voteRefusal(
        ports,
        plainPlan(),
        [],
        voterOf({ by: 'ops', onBehalfOf: 'm1' }),
        null,
        'm1',
      ),
    ).toMatch(/onBehalfOf is for a company approval/);
    const plan = await planApproval(
      ports,
      { approvers: 'company:approver' },
      { customerId: 'acme' },
    );
    expect(await voteRefusal(ports, plan, [], voterOf({ id: 'p1', by: 'ops' }), null)).toMatch(
      /decided by a company’s members/,
    );
  });

  it('holds a member to separation of duties when the setting is on, and not when off', async () => {
    const order = { meta: { buyerId: 'm1' } };
    for (const [separation, refused] of [
      ['on', true],
      ['off', false],
    ] as const) {
      const { ports } = setup({ settings: { [APPROVAL_SEPARATION_KEY]: separation } });
      const plan = await planApproval(
        ports,
        { approvers: 'company:approver' },
        { customerId: 'acme' },
      );
      const problem = await voteRefusal(
        ports,
        plan,
        [],
        voterOf({ by: 'ops', onBehalfOf: 'm1' }),
        order,
        'm1',
      );
      expect(problem !== null).toBe(refused);
    }
  });
});

describe('tallyWith', () => {
  it('shows where a vote would leave the tally without recording it', async () => {
    const { ports } = setup();
    const plan = await planApproval(
      ports,
      { approvers: 'company:approver', mode: 'all' },
      { customerId: 'acme' },
    );
    const after = tallyWith(plan, [], voterOf({ by: 'ops', onBehalfOf: 'm1' }), 'approved');
    expect(after).toMatchObject({ status: 'pending', label: '1 of 2' });
    const rejected = tallyWith(plan, [], voterOf({ by: 'ops', onBehalfOf: 'm1' }), 'rejected');
    expect(rejected.status).toBe('rejected');
  });
});
