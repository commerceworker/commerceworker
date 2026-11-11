/**
 * Approvals decided by votes (docs/b2b.md, S5), on real Workflows. An Approval step names its
 * approvers and a mode; the OrderAgent records each vote and sends the Workflow its one decision
 * event only once the votes decide the step, so the Workflow, its step names and the escalation
 * on timeout are the ones every flow already had. Company members vote through staff recording
 * their vote (`onBehalfOf`, D3).
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  APPROVAL_SEPARATION_KEY,
  type FlowNode,
  type OrderInput,
  type OrderState,
  type Principal,
  type Role,
} from '@commerceworker/core';
import {
  approvals,
  approvalVotes,
  auditEvents,
  createDb,
  orders,
  publishFlow,
  users,
  workspaceSettings,
} from '@commerceworker/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { previewAction, Refused, runAction } from '../src/assistant/data';
import { ensureTemplates } from '../src/flows';
import { startOrder } from '../src/orders';
import { companyDirectory, workspaceStore } from '../src/wire';
import { signedActor } from './principal';

const db = () => createDb(env.DB);
const dir = () => companyDirectory(env);
const suffix = () => crypto.randomUUID().slice(0, 8);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const state = async (id: string) => (await agent(id).snapshot()) as OrderState;
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);

async function until<T>(fn: () => Promise<T | undefined | false>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r as T;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const waitingOn = (id: string, pred: (s: OrderState) => boolean, what: string) =>
  until(async () => (pred(await state(id)) ? await state(id) : false), what);
const settled = (id: string) =>
  waitingOn(
    id,
    (s) => ['completed', 'declined', 'cancelled', 'failed'].includes(s.status),
    'a terminal status',
  );
/**
 * The order's D1 index row once `ok` holds. The agent reports a status first and writes the row
 * after (`report` awaits `syncIndex`), so a read right after a snapshot shows the wait or the end
 * can still see the row from before it.
 */
const indexRow = (orderId: string, ok: (r: typeof orders.$inferSelect) => boolean) =>
  until(async () => {
    const r = await db().select().from(orders).where(eq(orders.id, orderId)).get();
    return r && ok(r) ? r : false;
  }, 'the order’s index row');

const waitingApproval = (id: string) =>
  waitingOn(id, (s) => s.waits.some((w) => w.kind === 'approval'), 'the approval');

/** Staff as the web app signs them for one decision, the way REST calls it. */
const decide = async (
  orderId: string,
  nodeId: string,
  decision: 'approved' | 'rejected',
  who: { id: string; role?: Role },
  extra: { note?: string; onBehalfOf?: string } = {},
) =>
  api().decide(
    orderId,
    nodeId,
    decision,
    await signedActor(
      { kind: 'staff', id: who.id, name: `${who.id}@example.com`, role: who.role ?? 'approver' },
      `decide:${orderId}`,
    ),
    extra.note,
    extra.onBehalfOf,
  );

/** A business customer with an active company: three approvers, a buyer and an inactive approver. */
async function company(status: 'active' | 'suspended' = 'active') {
  const id = `cv_${suffix()}`;
  await dir().createCustomer(
    {
      id,
      name: `Co ${id}`,
      email: `${id}@example.test`,
      kind: 'business',
      tier: 'gold',
      terms: 'net_30',
    },
    {
      customerId: id,
      status,
      legalName: `${id} Ltd`,
      taxId: null,
      parentCompanyId: null,
      createdAt: 1,
      updatedAt: 1,
    },
  );
  await dir().putTeam({
    id: `${id}_t`,
    companyId: id,
    parentId: null,
    name: 'Ops',
    path: `/${id}_t/`,
  });
  const member = (key: string, over: object = {}) => ({
    id: `${id}_${key}`,
    name: key,
    email: `${key}@${id}.test`,
    role: 'approver' as const,
    teamId: null,
    status: 'active' as const,
    orderLimit: null,
    ...over,
  });
  await dir().upsertMembers(
    id,
    [
      member('ann', { teamId: `${id}_t` }),
      member('bo'),
      member('cy'),
      member('di', { role: 'buyer' }),
      member('ed', { status: 'inactive' }),
    ],
    1,
  );
  const m = (k: string) => `${id}_${k}`;
  return { id, ann: m('ann'), bo: m('bo'), cy: m('cy'), di: m('di'), ed: m('ed'), team: `${id}_t` };
}

const node = (id: string, type: string, config: Record<string, unknown> = {}): FlowNode => ({
  id,
  type,
  label: id,
  config,
  position: { x: 0, y: 0 },
});
const edge = (source: string, target: string, sourceHandle: string | null = null) => ({
  id: `${source}.${sourceHandle ?? 'out'}-${target}`,
  source,
  target,
  sourceHandle,
  targetHandle: null,
});

/** One approval step that ends the order completed, declined or cancelled on its three branches. */
async function approvalFlow(id: string, config: Record<string, unknown>) {
  await publishFlow(db(), {
    id,
    name: id,
    description: '',
    model: 'b2b',
    channels: [],
    nodes: [
      node('start', 'trigger.manual'),
      node('appr', 'control.approval', { title: 'Approve it', assignee: 'ops', ...config }),
      node('ok', 'control.end', { outcome: 'completed', reason: 'Approved' }),
      node('no', 'control.end', { outcome: 'declined', reason: 'Rejected' }),
      node('late', 'control.end', { outcome: 'cancelled', reason: 'Nobody decided' }),
    ],
    edges: [
      edge('start', 'appr'),
      edge('appr', 'ok', 'approved'),
      edge('appr', 'no', 'rejected'),
      edge('appr', 'late', 'escalated'),
    ],
  });
}

const input = (customerId: string, meta: Record<string, unknown> = {}): OrderInput => ({
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  customerId,
  lines: [],
  meta,
});

const ruleOf = (orderId: string) =>
  db().select().from(approvals).where(eq(approvals.orderId, orderId)).get();
const votesOf = (orderId: string) =>
  db()
    .select({ v: approvalVotes })
    .from(approvalVotes)
    .innerJoin(approvals, eq(approvals.id, approvalVotes.approvalId))
    .where(eq(approvals.orderId, orderId))
    .then((rows) => rows.map((r) => r.v));

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
async function introspect(timeouts: string[] = []) {
  introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    for (const name of timeouts) await m.forceEventTimeout({ name });
  });
}
afterEach(async () => {
  await introspector?.dispose();
});

beforeAll(async () => {
  await ensureTemplates(env);
  await approvalFlow('test-vote-quorum', {
    approvers: 'company:approver',
    mode: 'quorum',
    quorum: 2,
  });
  await approvalFlow('test-vote-plain', {});
  await approvalFlow('test-vote-staff-all', { approvers: 'staff:approver', mode: 'all' });
});

const alice = { id: 'usr_vote_admin', role: 'admin' as Role };

describe('a quorum of company approvers', () => {
  it('waits at the first vote, and resumes the order at the second', async () => {
    await introspect();
    const c = await company();
    const { orderId } = await startOrder(env, {
      flowId: 'test-vote-quorum',
      input: input(c.id),
    });
    const waiting = await waitingApproval(orderId);
    // The wait carries who may vote; the buyer, the inactive approver and outsiders are not.
    const wait = waiting.waits.find((w) => w.kind === 'approval')!;
    expect(wait.approval).toMatchObject({
      approvers: 'company:approver',
      mode: 'quorum',
      quorum: 2,
      companyId: c.id,
    });
    expect([...wait.approval!.eligible!].sort()).toEqual([c.ann, c.bo, c.cy].sort());
    expect(await ruleOf(orderId)).toMatchObject({
      status: 'pending',
      companyId: c.id,
      approvers: 'company:approver',
      mode: 'quorum',
      required: 2,
      assignee: 'ops',
    });
    // `waiting_for` names the approvers, not the assignee label.
    expect(
      (await indexRow(orderId, (r) => r.waitingFor === 'approvers:company:approver')).waitingFor,
    ).toBe('approvers:company:approver');

    const first = await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.ann });
    expect(first).toEqual({ ok: true, outcome: 'recorded', tally: '1 of 2' });
    // The vote counted; the order did not move, and the approval is still open.
    expect((await state(orderId)).waits.some((w) => w.kind === 'approval')).toBe(true);
    expect((await ruleOf(orderId))!.status).toBe('pending');
    expect(await votesOf(orderId)).toMatchObject([
      { voterId: c.ann, voterKind: 'member', onBehalfBy: alice.id, decision: 'approved' },
    ]);
    // The timeline says whose vote it was and who recorded it.
    expect((await state(orderId)).timeline.map((t) => t.message)).toContain(
      'Approve it: ann voted to approve (recorded by usr_vote_admin@example.com) (1 of 2)',
    );

    // A vote sent again is the one already recorded: it neither counts twice nor decides.
    expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.ann })).toEqual({
      ok: true,
      outcome: 'recorded',
      tally: '1 of 2',
    });
    expect(await votesOf(orderId)).toHaveLength(1);
    expect((await state(orderId)).waits.some((w) => w.kind === 'approval')).toBe(true);

    const second = await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.bo });
    expect(second).toEqual({ ok: true, outcome: 'approved', tally: '2 of 2' });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.nodes.appr!.branches).toEqual(['approved']);
    expect(await ruleOf(orderId)).toMatchObject({ status: 'approved' });
    expect(await votesOf(orderId)).toHaveLength(2);
  });

  it('ends on a rejection, and takes no vote after it', async () => {
    await introspect();
    const c = await company();
    const { orderId } = await startOrder(env, { flowId: 'test-vote-quorum', input: input(c.id) });
    await waitingApproval(orderId);
    expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.ann })).toMatchObject({
      outcome: 'recorded',
    });
    // One no ends it, though the quorum was one approval short and two members were still to vote.
    expect(
      await decide(orderId, 'appr', 'rejected', alice, { onBehalfOf: c.bo, note: 'Over budget' }),
    ).toEqual({ ok: true, outcome: 'rejected', tally: '1 of 2' });
    const done = await settled(orderId);
    expect(done.status).toBe('declined');
    expect(done.nodes.appr!.branches).toEqual(['rejected']);
    expect(await ruleOf(orderId)).toMatchObject({ status: 'rejected', note: 'Over budget' });
    // Nothing more is waiting: the third member's vote has nowhere to go.
    expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.cy })).toMatchObject({
      ok: false,
      reason: 'not_waiting',
    });
  });

  it('refuses a vote that can’t be taken, and says why', async () => {
    await introspect();
    const c = await company();
    const other = await company();
    const { orderId } = await startOrder(env, { flowId: 'test-vote-quorum', input: input(c.id) });
    await waitingApproval(orderId);
    const refuse = async (extra: { onBehalfOf?: string }, who = alice) =>
      decide(orderId, 'appr', 'approved', who, extra);
    // Staff decide a company's approval only by recording a member's vote.
    expect(await refuse({})).toMatchObject({
      ok: false,
      reason: 'refused',
      error: expect.stringContaining('onBehalfOf'),
    });
    // Not an approver: a buyer, an inactive approver, another company's member, nobody.
    for (const who of [c.di, c.ed, other.ann, 'mem_ghost'])
      expect(await refuse({ onBehalfOf: who })).toMatchObject({
        ok: false,
        reason: 'refused',
        error: expect.stringContaining('isn’t one of this approval’s approvers'),
      });
    // Recording one needs the Approver role.
    expect(await refuse({ onBehalfOf: c.ann }, { id: 'usr_viewer', role: 'viewer' })).toMatchObject(
      { ok: false, reason: 'forbidden' },
    );
    expect(await votesOf(orderId)).toEqual([]);

    // Voting twice, even to change one's mind.
    expect(await refuse({ onBehalfOf: c.ann })).toMatchObject({ outcome: 'recorded' });
    expect(await decide(orderId, 'appr', 'rejected', alice, { onBehalfOf: c.ann })).toMatchObject({
      ok: false,
      reason: 'refused',
      error: 'This person has already voted.',
    });
    await agent(orderId).cancel('Test over');
  });

  it('refuses the buyer’s own vote when the workspace separates approvals', async () => {
    await introspect();
    const c = await company();
    const { orderId } = await startOrder(env, {
      flowId: 'test-vote-quorum',
      input: input(c.id, { buyerId: c.ann }),
    });
    await waitingApproval(orderId);
    await db().insert(workspaceSettings).values({
      key: APPROVAL_SEPARATION_KEY,
      value: 'on',
      updatedAt: Date.now(),
      updatedBy: 'test',
    });
    try {
      // The member who placed the order may not approve it, however staff record it.
      expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.ann })).toEqual({
        ok: false,
        reason: 'refused',
        error: 'A buyer can’t decide their own order.',
      });
      // Another member may.
      expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.bo })).toMatchObject({
        ok: true,
        outcome: 'recorded',
      });
      expect(await votesOf(orderId)).toHaveLength(1);
    } finally {
      await db()
        .delete(workspaceSettings)
        .where(eq(workspaceSettings.key, APPROVAL_SEPARATION_KEY));
      await agent(orderId).cancel('Test over');
    }
  });

  it('lets the buyer vote when the workspace doesn’t separate approvals', async () => {
    await introspect();
    const c = await company();
    const { orderId } = await startOrder(env, {
      flowId: 'test-vote-quorum',
      input: input(c.id, { buyerId: c.ann }),
    });
    await waitingApproval(orderId);
    expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.ann })).toMatchObject({
      ok: true,
      outcome: 'recorded',
    });
    await agent(orderId).cancel('Test over');
  });

  it('can’t be voted once the company stops being active', async () => {
    await introspect();
    const c = await company();
    const { orderId } = await startOrder(env, { flowId: 'test-vote-quorum', input: input(c.id) });
    await waitingApproval(orderId);
    await dir().transitionCompany({ all: true }, c.id, 'active', 'suspended', 2);
    expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.ann })).toEqual({
      ok: false,
      reason: 'refused',
      error: 'The company isn’t active, so its members can’t vote.',
    });
    await agent(orderId).cancel('Test over');
  });

  it('escalates when the vote is still open at the timeout, as an approval always did', async () => {
    await introspect(['appr#1']);
    const c = await company();
    const { orderId } = await startOrder(env, { flowId: 'test-vote-quorum', input: input(c.id) });
    const done = await settled(orderId);
    expect(done.status).toBe('cancelled');
    expect(done.reason).toBe('Nobody decided');
    expect(done.nodes.appr!.branches).toEqual(['escalated']);
    expect(await ruleOf(orderId)).toMatchObject({ status: 'escalated', decidedBy: 'timeout' });
  });

  it('has nobody to vote for an order with no company, and escalates at the timeout', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'test-vote-quorum',
      input: input('cus_ada'),
    });
    const wait = (await waitingApproval(orderId)).waits.find((w) => w.kind === 'approval')!;
    expect(wait.approval?.eligible).toEqual([]);
    expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: 'mem_x' })).toMatchObject(
      { ok: false, reason: 'refused' },
    );
    await agent(orderId).cancel('Test over');
  });
});

describe('every member of a named list', () => {
  it('compares who approved, not how many', async () => {
    await introspect();
    const c = await company();
    // The flow names the members by id; this one is written for this company.
    await approvalFlow(`test-vote-all-${c.id}`, {
      approvers: `members:${c.ann},${c.bo}`,
      mode: 'all',
    });
    const { orderId } = await startOrder(env, {
      flowId: `test-vote-all-${c.id}`,
      input: input(c.id),
    });
    await waitingApproval(orderId);
    expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.ann })).toMatchObject({
      outcome: 'recorded',
      tally: '1 of 2',
    });
    // A member who isn't named can't take the second place.
    expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.cy })).toMatchObject({
      ok: false,
      reason: 'refused',
    });
    expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.bo })).toMatchObject({
      outcome: 'approved',
      tally: '2 of 2',
    });
    expect((await settled(orderId)).status).toBe('completed');
  });
});

describe('an approval with the default fields', () => {
  it('is what it always was: any one staff approver decides it at once', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'test-vote-plain',
      input: input('cus_contoso'),
    });
    const waiting = await waitingApproval(orderId);
    expect(waiting.timeline.map((t) => t.message)).toContain('Awaiting approval: Approve it (ops)');
    expect(await ruleOf(orderId)).toMatchObject({
      companyId: null,
      approvers: 'staff:approver',
      mode: 'any',
      required: 1,
      eligible: null,
      assignee: 'ops',
    });
    // `waiting_for` is still the assignee.
    expect((await indexRow(orderId, (r) => r.waitingFor === 'person:ops')).waitingFor).toBe(
      'person:ops',
    );
    expect(await decide(orderId, 'appr', 'approved', { id: 'usr_plain' })).toEqual({
      ok: true,
      outcome: 'approved',
      tally: '1 of 1',
    });
    const done = await settled(orderId);
    expect(done.status).toBe('completed');
    expect(done.timeline.map((t) => t.message)).toContain(
      'Approve it: approved by usr_plain@example.com',
    );
    expect(await ruleOf(orderId)).toMatchObject({
      status: 'approved',
      decidedBy: 'usr_plain@example.com',
    });
    expect(await votesOf(orderId)).toMatchObject([
      { voterId: 'usr_plain', voterKind: 'staff', onBehalfBy: null },
    ]);
  });

  it('refuses onBehalfOf on a staff approval, and one decided twice in the meantime', async () => {
    await introspect();
    const { orderId } = await startOrder(env, {
      flowId: 'test-vote-plain',
      input: input('cus_contoso'),
    });
    await waitingApproval(orderId);
    expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: 'mem_x' })).toMatchObject(
      {
        ok: false,
        reason: 'refused',
        error: expect.stringContaining('onBehalfOf is for a company approval'),
      },
    );
    await decide(orderId, 'appr', 'rejected', alice);
    expect((await settled(orderId)).status).toBe('declined');
  });

  it('keeps the escalation on timeout', async () => {
    await introspect(['appr#1']);
    const { orderId } = await startOrder(env, {
      flowId: 'test-vote-plain',
      input: input('cus_contoso'),
    });
    const done = await settled(orderId);
    expect(done.nodes.appr!.branches).toEqual(['escalated']);
    expect(await ruleOf(orderId)).toMatchObject({ status: 'escalated' });
  });

  it('holds a decision to the role the approvers name', async () => {
    await introspect();
    await approvalFlow('test-vote-operator', { approvers: 'staff:operator' });
    const { orderId } = await startOrder(env, {
      flowId: 'test-vote-operator',
      input: input('cus_contoso'),
    });
    await waitingApproval(orderId);
    expect(await decide(orderId, 'appr', 'approved', { id: 'usr_appr', role: 'approver' })).toEqual(
      {
        ok: false,
        reason: 'refused',
        error: 'This approval needs the operator role.',
      },
    );
    expect(
      await decide(orderId, 'appr', 'approved', { id: 'usr_op', role: 'operator' }),
    ).toMatchObject({ outcome: 'approved' });
    expect((await settled(orderId)).status).toBe('completed');
  });
});

describe('every staff approver', () => {
  it('counts the team’s people, and takes the vote of each', async () => {
    await introspect();
    // Two on the team, one of them disabled, and a viewer, who isn't an approver at all.
    const team = (role: string, over: object = {}) => ({
      id: `usr_vote_${role}_${suffix()}`,
      name: role,
      email: `${role}-${suffix()}@example.com`,
      role,
      createdAt: 1,
      ...over,
    });
    await db()
      .insert(users)
      .values([
        team('approver'),
        team('operator'),
        team('viewer'),
        team('admin', { disabledAt: 5 }),
      ]);
    const { people } = await workspaceStore(env).team();
    const staff = people.filter(
      (p) => !p.disabledAt && ['approver', 'operator', 'admin'].includes(p.role),
    );
    expect(staff.length).toBeGreaterThanOrEqual(2);
    const { orderId } = await startOrder(env, {
      flowId: 'test-vote-staff-all',
      input: input('cus_contoso'),
    });
    const wait = (await waitingApproval(orderId)).waits.find((w) => w.kind === 'approval')!;
    expect([...wait.approval!.eligible!].sort()).toEqual(staff.map((p) => p.id).sort());
    // `person:` stays the wait's label: the approvers are staff.
    expect((await indexRow(orderId, (r) => r.waitingFor === 'person:ops')).waitingFor).toBe(
      'person:ops',
    );
    for (const [i, p] of staff.entries()) {
      const r = await decide(orderId, 'appr', 'approved', { id: p.id, role: p.role as Role });
      expect(r).toMatchObject({
        ok: true,
        outcome: i === staff.length - 1 ? 'approved' : 'recorded',
        tally: `${i + 1} of ${staff.length}`,
      });
    }
    expect((await settled(orderId)).status).toBe('completed');
  });
});

describe('the assistant and MCP route', () => {
  const principal = (role: Role, id = 'usr_vote_assist'): Principal => ({
    kind: 'user',
    id,
    name: role,
    email: `${id}@example.com`,
    role,
  });

  it('previews a vote, records it with who did, and audits onBehalfOf', async () => {
    await introspect();
    const c = await company();
    const { orderId } = await startOrder(env, { flowId: 'test-vote-quorum', input: input(c.id) });
    await waitingApproval(orderId);
    const staff = principal('approver');

    // A card says what confirming does: a vote, not the decision, and whose.
    const preview = await previewAction(env, staff, 'decide_approval', {
      orderId,
      decision: 'approved',
      onBehalfOf: c.ann,
    });
    expect(preview.blocked).toBeUndefined();
    expect(preview.consequences).toEqual(
      expect.arrayContaining([
        'Decided by: Company approvers, 2 of 3 must approve',
        `Records ${c.ann}’s vote; you are named as having recorded it`,
        'Counts as a vote (1 of 2); the order keeps waiting until it is decided',
      ]),
    );
    // Without a member, the card is blocked before anyone confirms.
    expect(
      (await previewAction(env, staff, 'decide_approval', { orderId, decision: 'approved' }))
        .blocked,
    ).toMatch(/onBehalfOf/);
    // A preview changes nothing.
    expect(await votesOf(orderId)).toEqual([]);

    const done = await runAction(env, staff, 'decide_approval', {
      orderId,
      decision: 'approved',
      onBehalfOf: c.ann,
      note: 'Fine by Ann',
    });
    expect(done).toMatchObject({ outcome: 'recorded', tally: '1 of 2' });
    expect(String(done.done)).toMatch(/Recorded a vote on .* \(1 of 2\)/);
    await expect(
      runAction(env, staff, 'decide_approval', {
        orderId,
        decision: 'approved',
        onBehalfOf: c.ann,
      }),
    ).resolves.toMatchObject({ tally: '1 of 2' });

    const logged = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'approval.decided'), eq(auditEvents.target, orderId)));
    expect(logged[0]).toMatchObject({ actor: 'usr_vote_assist@example.com', actorKind: 'user' });
    expect(JSON.parse(logged[0]!.detail!)).toMatchObject({
      decision: 'approved',
      onBehalfOf: c.ann,
      outcome: 'recorded',
      tally: '1 of 2',
      note: 'Fine by Ann',
      tool: 'decide_approval',
    });
    // The vote itself names who recorded it.
    expect(await votesOf(orderId)).toMatchObject([
      { voterId: c.ann, onBehalfBy: 'usr_vote_assist', note: 'Fine by Ann' },
    ]);

    // One batch of approvals records its member's vote on each, and says where each stands.
    const second = await startOrder(env, { flowId: 'test-vote-quorum', input: input(c.id) });
    await waitingApproval(second.orderId);
    const batch = await runAction(env, staff, 'decide_approvals', {
      decision: 'approved',
      onBehalfOf: c.bo,
      approvals: [
        { orderId, nodeId: 'appr' },
        { orderId: second.orderId, nodeId: 'appr' },
      ],
    });
    expect(batch).toMatchObject({
      results: [
        { orderId, ok: true, outcome: 'approved', tally: '2 of 2' },
        { orderId: second.orderId, ok: true, outcome: 'recorded', tally: '1 of 2' },
      ],
    });
    expect((await settled(orderId)).status).toBe('completed');
    await agent(second.orderId).cancel('Test over');
  });

  it('refuses what the vote refuses', async () => {
    await introspect();
    const c = await company();
    const { orderId } = await startOrder(env, { flowId: 'test-vote-quorum', input: input(c.id) });
    await waitingApproval(orderId);
    await expect(
      runAction(env, principal('approver'), 'decide_approval', {
        orderId,
        decision: 'approved',
        onBehalfOf: c.di,
      }),
    ).rejects.toBeInstanceOf(Refused);
    await agent(orderId).cancel('Test over');
  });
});

describe('a threshold is flow logic', () => {
  it('routes a gold company’s order to its members’ approval and leaves others alone', async () => {
    await introspect();
    await publishFlow(db(), {
      id: 'test-vote-threshold',
      name: 'Threshold',
      description: '',
      model: 'b2b',
      channels: [],
      nodes: [
        node('start', 'trigger.manual'),
        node('gold', 'control.condition', {
          expression: { '==': [{ var: 'company.tier' }, 'gold'] },
        }),
        node('appr', 'control.approval', {
          title: 'Members approve',
          approvers: 'company:approver',
          mode: 'majority',
        }),
        node('ok', 'control.end', { outcome: 'completed', reason: 'Approved' }),
        node('no', 'control.end', { outcome: 'declined', reason: 'Rejected' }),
        node('late', 'control.end', { outcome: 'cancelled', reason: 'Nobody decided' }),
        node('plain', 'control.end', { outcome: 'completed', reason: 'No approval needed' }),
      ],
      edges: [
        edge('start', 'gold'),
        edge('gold', 'appr', 'true'),
        edge('gold', 'plain', 'false'),
        edge('appr', 'ok', 'approved'),
        edge('appr', 'no', 'rejected'),
        edge('appr', 'late', 'escalated'),
      ],
    });
    const c = await company();
    const { orderId } = await startOrder(env, {
      flowId: 'test-vote-threshold',
      input: input(c.id),
    });
    await waitingApproval(orderId);
    // Three approvers, a majority of more than half: two votes.
    expect(await ruleOf(orderId)).toMatchObject({ mode: 'majority', required: 2 });
    await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.ann });
    expect(await decide(orderId, 'appr', 'approved', alice, { onBehalfOf: c.cy })).toMatchObject({
      outcome: 'approved',
    });
    expect((await settled(orderId)).status).toBe('completed');

    const none = await startOrder(env, {
      flowId: 'test-vote-threshold',
      input: input('cus_contoso'),
    });
    const ended = await settled(none.orderId);
    expect(ended.reason).toBe('No approval needed');
    expect(await ruleOf(none.orderId)).toBeUndefined();
  });
});
