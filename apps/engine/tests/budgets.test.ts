/**
 * Budgets in the engine (docs/b2b.md, S4): the budget check holding an order to its company's and
 * its buyer's team's budgets through real Workflows (a strict one declines, an advisory one warns,
 * two orders racing for a strict one take only what fits), the spend it records given back on a
 * rollback, a decline and a cancel, and the tools staff and agents manage budgets with over REST's
 * `runOperation` and the assistant's confirmed changes.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  type Budget,
  type FlowNode,
  type Order,
  type OrderInput,
  type OrderState,
  PERSON_CONFIRMS_TOOLS,
  type Principal,
  type Role,
  type RpcActor,
  type RunContext,
  withDefaults,
} from '@commerceworker/core';
import { createDb, publishFlow } from '@commerceworker/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { previewAction, runAction } from '../src/assistant/data';
import { compensateOrder } from '../src/connectors';
import { ensureTemplates } from '../src/flows';
import { EXECUTORS, ROLLBACKS } from '../src/nodes';
import { startOrder } from '../src/orders';
import { budgetStore, companyDirectory } from '../src/wire';
import { signedActor } from './principal';

const ALL = { all: true } as const;
const dir = () => companyDirectory(env);
const budgets = () => budgetStore(env);
const suffix = () => crypto.randomUUID().slice(0, 8);
const db = () => createDb(env.DB);
const agent = (id: string) => env.ORDER_AGENT.getByName(id);
const state = async (id: string) => (await agent(id).snapshot()) as OrderState;

async function until<T>(fn: () => Promise<T | false>, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const waitingOn = (id: string, pred: (s: OrderState) => boolean, what: string) =>
  until(async () => {
    const s = await state(id);
    return pred(s) ? s : false;
  }, what);
const settled = (id: string) =>
  waitingOn(
    id,
    (s) => ['completed', 'declined', 'cancelled', 'failed', 'rolled_back'].includes(s.status),
    'a terminal status',
  );
const checked = (id: string) =>
  waitingOn(id, (s) => !!s.nodes.budget?.branches, 'the budget check');

let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;
async function introspect() {
  introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
}
afterEach(async () => {
  await introspector?.dispose();
});

const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const staff = (role: Role): RpcActor =>
  ({ kind: 'staff', id: `usr_bud_${role}`, name: `${role}@example.com`, role }) as RpcActor;
const run = async (tool: string, input: unknown, actor: RpcActor) => {
  const { operationCall } = await import('@commerceworker/core');
  return api().runOperation(
    tool,
    input,
    await signedActor(actor, await operationCall(tool, input)),
  );
};
const principal = (role: Role): Principal => ({
  kind: 'user',
  id: `usr_bud_${role}`,
  name: role,
  email: `${role}@example.com`,
  role,
});

/** A business customer with an active company, a team under a team, and a buyer in the inner one. */
async function company() {
  const id = `cb_${suffix()}`;
  await dir().createCustomer(
    {
      id,
      name: `Co ${id}`,
      email: `${id}@example.test`,
      kind: 'business',
      tier: 'standard',
      terms: 'net_30',
    },
    {
      customerId: id,
      status: 'active',
      legalName: `${id} Ltd`,
      taxId: null,
      parentCompanyId: null,
      createdAt: 1,
      updatedAt: 1,
    },
  );
  const outer = `${id}_outer`;
  const inner = `${id}_inner`;
  const elsewhere = `${id}_else`;
  await dir().putTeam({
    id: outer,
    companyId: id,
    parentId: null,
    name: 'Outer',
    path: `/${outer}/`,
  });
  await dir().putTeam({
    id: inner,
    companyId: id,
    parentId: outer,
    name: 'Inner',
    path: `/${outer}/${inner}/`,
  });
  await dir().putTeam({
    id: elsewhere,
    companyId: id,
    parentId: null,
    name: 'Elsewhere',
    path: `/${elsewhere}/`,
  });
  await dir().upsertMembers(
    id,
    [
      {
        id: `${id}_ann`,
        name: 'Ann',
        email: `ann@${id}.test`,
        role: 'buyer',
        teamId: inner,
        status: 'active',
        orderLimit: null,
      },
    ],
    1,
  );
  return { id, ann: `${id}_ann`, outer, inner, elsewhere };
}

let nextBudget = 0;
async function budget(companyId: string, over: Partial<Budget> = {}) {
  const b: Budget = {
    id: `bud_${suffix()}_${nextBudget++}`,
    companyId,
    teamId: null,
    name: `Budget ${nextBudget}`,
    amount: 1_000,
    period: 'one_time',
    anchor: 0,
    enforcement: 'advisory',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
  expect(await budgets().put(b)).toBe(true);
  return b;
}
/** What the budget has spent in its one window. */
async function spent(b: Budget) {
  return (await budgets().spentIn([{ budgetId: b.id, windowStart: b.anchor }])).get(
    `${b.id}@${b.anchor}`,
  );
}

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
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
const flow = (id: string, nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[]) =>
  publishFlow(db(), { id, name: id, description: '', model: 'b2b', channels: [], nodes, edges });

/** Each order is for 600 at the price it names: the price node keeps given prices. */
const PRICE = node('price', 'commerce.price', { useContracts: false, usePriceRules: false });
const order = (customerId: string, buyerId?: string): OrderInput => ({
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  customerId,
  lines: [{ sku: 'WID-100', qty: 1, unitPrice: 600 }],
  meta: buyerId ? { buyerId } : {},
});

/** One budget check from the company's budgets, then `after`; over ends declined. */
const withCheck = (
  id: string,
  config: Record<string, unknown>,
  after: ReturnType<typeof node>[],
  afterEdges: ReturnType<typeof edge>[],
) =>
  flow(
    id,
    [
      node('start', 'trigger.manual'),
      PRICE,
      node('budget', 'commerce.budget_check', config),
      ...after,
      node('over', 'control.end', { outcome: 'declined', reason: 'Over budget' }),
    ],
    [
      edge('start', 'price'),
      edge('price', 'budget'),
      edge('budget', 'over', 'over'),
      ...afterEdges,
    ],
  );

beforeAll(async () => {
  await ensureTemplates(env);
  const COMPANY = { source: 'company', commit: true };
  // The spend stays recorded while the order waits on `go`, as it does while an order waits.
  await withCheck(
    'test-budget-wait',
    COMPANY,
    [
      node('go', 'control.wait_event', { event: 'go' }),
      node('done', 'control.end', { outcome: 'completed', reason: 'Went' }),
    ],
    [edge('budget', 'go', 'within'), edge('go', 'done', 'received')],
  );
  await withCheck(
    'test-budget-fail',
    COMPANY,
    [node('boom', 'control.end', { outcome: 'failed', reason: 'Something broke' })],
    [edge('budget', 'boom', 'within')],
  );
  await withCheck(
    'test-budget-decline',
    COMPANY,
    [node('no', 'control.end', { outcome: 'declined', reason: 'Not wanted' })],
    [edge('budget', 'no', 'within')],
  );
  await withCheck(
    'test-budget-complete',
    COMPANY,
    [node('done', 'control.end', { outcome: 'completed', reason: 'Done' })],
    [edge('budget', 'done', 'within')],
  );
  await withCheck(
    'test-budget-check-only',
    { source: 'company' },
    [node('done', 'control.end', { outcome: 'completed', reason: 'Done' })],
    [edge('budget', 'done', 'within')],
  );
  await withCheck(
    'test-budget-node',
    { budget: 500 },
    [node('done', 'control.end', { outcome: 'completed', reason: 'Done' })],
    [edge('budget', 'done', 'within')],
  );
});

type CheckOutput = {
  total: number;
  committed: boolean;
  budgets: { budgetId: string; remaining: number; exceeded: boolean; warning: string | null }[];
};
const outputOf = (s: OrderState) => s.nodes.budget?.output as CheckOutput;

describe('the budget check from the company', () => {
  it('declines an order a strict budget would go below zero for, recording nothing', async () => {
    await introspect();
    const c = await company();
    const strict = await budget(c.id, { enforcement: 'strict', amount: 500 });
    const { orderId } = await startOrder(env, {
      flowId: 'test-budget-wait',
      input: order(c.id),
    });
    const s = await settled(orderId);
    expect(s.nodes.budget?.branches).toEqual(['over']);
    expect(s.status).toBe('declined');
    expect(outputOf(s)).toMatchObject({
      total: 600,
      committed: false,
      budgets: [{ budgetId: strict.id, remaining: -100, exceeded: true, warning: null }],
    });
    expect(s.nodes.budget?.summary).toBe(`Over ${strict.name}`);
    expect(await spent(strict)).toBe(0);
  });

  it('lets an advisory budget through with a warning, and records the spend', async () => {
    await introspect();
    const c = await company();
    const advisory = await budget(c.id, { amount: 500 });
    const { orderId } = await startOrder(env, {
      flowId: 'test-budget-wait',
      input: order(c.id),
    });
    const s = await checked(orderId);
    expect(s.nodes.budget?.branches).toEqual(['within']);
    const out = outputOf(s);
    expect(out.committed).toBe(true);
    expect(out.budgets[0]).toMatchObject({
      budgetId: advisory.id,
      remaining: -100,
      exceeded: true,
      warning: expect.stringContaining('advisory, so the order passes'),
    });
    expect(s.nodes.budget?.summary).toContain('Within 1 budget, spend recorded');
    expect(s.nodes.budget?.summary).toContain('advisory');
    expect(await spent(advisory)).toBe(600);
  });

  it('holds an order to the company’s budgets and its buyer’s team and the teams above, not to other teams’', async () => {
    await introspect();
    const c = await company();
    const whole = await budget(c.id, { name: 'a whole' });
    const outer = await budget(c.id, { name: 'b outer', teamId: c.outer });
    const inner = await budget(c.id, { name: 'c inner', teamId: c.inner });
    const other = await budget(c.id, { name: 'd elsewhere', teamId: c.elsewhere });
    const paused = await budget(c.id, { name: 'e paused', status: 'paused' });
    const another = await company();
    const foreign = await budget(another.id, { name: 'f foreign' });
    const { orderId } = await startOrder(env, {
      flowId: 'test-budget-complete',
      input: order(c.id, c.ann),
    });
    const s = await settled(orderId);
    expect(s.status).toBe('completed');
    expect(outputOf(s).budgets.map((b) => b.budgetId)).toEqual([whole.id, outer.id, inner.id]);
    expect(await spent(whole)).toBe(600);
    expect(await spent(outer)).toBe(600);
    expect(await spent(inner)).toBe(600);
    for (const untouched of [other, paused, foreign]) expect(await spent(untouched)).toBe(0);

    // With no buyer, the team budgets don't apply: only the company's own.
    const { orderId: bare } = await startOrder(env, {
      flowId: 'test-budget-complete',
      input: order(c.id),
    });
    expect(outputOf(await settled(bare)).budgets.map((b) => b.budgetId)).toEqual([whole.id]);
  });

  it('only checks, recording nothing, unless told to commit', async () => {
    await introspect();
    const c = await company();
    const b = await budget(c.id, { enforcement: 'strict' });
    const { orderId } = await startOrder(env, {
      flowId: 'test-budget-check-only',
      input: order(c.id),
    });
    const s = await settled(orderId);
    expect(s.status).toBe('completed');
    expect(outputOf(s)).toMatchObject({ committed: false, budgets: [{ remaining: 400 }] });
    expect(await spent(b)).toBe(0);
  });

  it('passes an order from a customer with no company or no budgets', async () => {
    await introspect();
    const c = await company();
    const { orderId } = await startOrder(env, {
      flowId: 'test-budget-complete',
      input: order(c.id),
    });
    const s = await settled(orderId);
    expect(s.nodes.budget?.summary).toBe('No budgets apply');
    expect(s.status).toBe('completed');
    const { orderId: consumer } = await startOrder(env, {
      flowId: 'test-budget-complete',
      input: order('cus_ada'),
    });
    expect((await settled(consumer)).nodes.budget?.summary).toBe('No budgets apply');
  });

  it('lets two orders racing for a strict budget take only what fits', async () => {
    await introspect();
    const c = await company();
    // 1,000 holds one order of 600, not two.
    const strict = await budget(c.id, { enforcement: 'strict', amount: 1_000 });
    const [a, b] = await Promise.all([
      startOrder(env, { flowId: 'test-budget-wait', input: order(c.id) }),
      startOrder(env, { flowId: 'test-budget-wait', input: order(c.id) }),
    ]);
    const [sa, sb] = await Promise.all([
      waitingOn(a.orderId, (s) => !!s.nodes.budget?.branches, 'the first check'),
      waitingOn(b.orderId, (s) => !!s.nodes.budget?.branches, 'the second check'),
    ]);
    expect([sa.nodes.budget!.branches![0], sb.nodes.budget!.branches![0]].sort()).toEqual([
      'over',
      'within',
    ]);
    expect(await spent(strict)).toBe(600);
  });

  it('counts a budget by calendar period, so spend from another window is not in it', async () => {
    await introspect();
    const c = await company();
    const monthly = await budget(c.id, {
      period: 'monthly',
      enforcement: 'strict',
      amount: 700,
    });
    // Spend a past month used up: it is another window and doesn't count now.
    await budgets().commit({
      orderId: 'ord_past',
      stepKey: 'budget#1',
      at: 1,
      lines: [
        {
          budgetId: monthly.id,
          amount: 700,
          window: { start: Date.UTC(2020, 0, 1), end: Date.UTC(2020, 1, 1) },
        },
      ],
    });
    const { orderId } = await startOrder(env, {
      flowId: 'test-budget-complete',
      input: order(c.id),
    });
    const s = await settled(orderId);
    expect(s.nodes.budget?.branches).toEqual(['within']);
    expect(outputOf(s).budgets[0]).toMatchObject({ spent: 0, remaining: 100 });
  });
});

describe('the budget check from the node keeps its behaviour', () => {
  it('holds one order to the amount set on the node, with no store read', async () => {
    await introspect();
    const c = await company();
    await budget(c.id, { enforcement: 'strict', amount: 1 });
    const { orderId } = await startOrder(env, { flowId: 'test-budget-node', input: order(c.id) });
    const s = await settled(orderId);
    // 600 against a node budget of 500; the company's strict budget of 1 isn't consulted.
    expect(s.nodes.budget?.branches).toEqual(['over']);
    expect(s.nodes.budget?.output).toEqual({ budget: 500 });
    expect(s.nodes.budget?.summary).toBe('Over budget of 500 USD');
  });
});

describe('giving back the spend', () => {
  it('has a rollback that reverses, and a spec that says so', async () => {
    const { NODE_SPECS } = await import('@commerceworker/core');
    expect(NODE_SPECS.find((n) => n.type === 'commerce.budget_check')?.rollback).toBe(true);
    expect(ROLLBACKS['commerce.budget_check']).toBeTypeOf('function');
  });

  it('reverses the spend when the order later fails, once', async () => {
    await introspect();
    const c = await company();
    const b = await budget(c.id, { enforcement: 'strict' });
    const { orderId } = await startOrder(env, { flowId: 'test-budget-fail', input: order(c.id) });
    const s = await settled(orderId);
    expect(s.status).toBe('failed');
    await until(async () => (await spent(b)) === 0, 'the rollback to reverse the spend');
    const rows = await budgets().entries(ALL, { budgetId: b.id, limit: 10 });
    expect(rows.rows).toMatchObject([{ orderId, amount: 600, reversed: true }]);
    // Run again (a retried rollback): nothing more is reversed.
    expect(await ROLLBACKS['commerce.budget_check']!(env, orderId, undefined, 'budget#1')).toBe(
      'Gave back 0 budget spends',
    );
    expect(await spent(b)).toBe(0);
  });

  it('reverses the spend of an order that ends declined, and keeps that of one that completes', async () => {
    await introspect();
    const c = await company();
    const b = await budget(c.id);
    const declined = await settled(
      (await startOrder(env, { flowId: 'test-budget-decline', input: order(c.id) })).orderId,
    );
    expect(declined.status).toBe('declined');
    expect(await spent(b)).toBe(0);
    const done = await settled(
      (await startOrder(env, { flowId: 'test-budget-complete', input: order(c.id) })).orderId,
    );
    expect(done.status).toBe('completed');
    expect(await spent(b)).toBe(600);
  });

  it('reverses the spend when the order is cancelled', async () => {
    await introspect();
    const c = await company();
    const b = await budget(c.id);
    const { orderId } = await startOrder(env, { flowId: 'test-budget-wait', input: order(c.id) });
    await checked(orderId);
    expect(await spent(b)).toBe(600);
    expect(await compensateOrder(env, orderId)).toMatchObject({ budgetSpendReversed: 1 });
    expect(await spent(b)).toBe(0);
    expect(await compensateOrder(env, orderId)).toMatchObject({ budgetSpendReversed: 0 });
  });

  it('gives a strict budget its room back, so the next order fits', async () => {
    await introspect();
    const c = await company();
    const strict = await budget(c.id, { enforcement: 'strict', amount: 700 });
    const first = await startOrder(env, { flowId: 'test-budget-wait', input: order(c.id) });
    await checked(first.orderId);
    const refused = await settled(
      (await startOrder(env, { flowId: 'test-budget-wait', input: order(c.id) })).orderId,
    );
    expect(refused.nodes.budget?.branches).toEqual(['over']);
    await compensateOrder(env, first.orderId);
    const next = await startOrder(env, { flowId: 'test-budget-wait', input: order(c.id) });
    expect((await checked(next.orderId)).nodes.budget?.branches).toEqual(['within']);
    expect(await spent(strict)).toBe(600);
  });
});

describe('a retried budget check', () => {
  const orderFor = (customerId: string): Order => ({
    id: `ord_bud_${suffix()}`,
    model: 'b2b',
    channel: 'api',
    currency: 'USD',
    customerId,
    lines: [{ sku: 'WID-100', qty: 1, unitPrice: 600 }],
    meta: {},
    createdAt: 0,
    subtotal: 600,
    shipping: 0,
    tax: 0,
    total: 600,
    fxRate: 1,
  });
  const check = (o: Order, stepKey: string) => {
    const ctx: RunContext = { order: o, nodes: {}, vars: {}, input: {}, now: 0, ref: o.id };
    const n: FlowNode = {
      id: 'budget',
      type: 'commerce.budget_check',
      label: 'budget',
      config: {},
      position: { x: 0, y: 0 },
    };
    return EXECUTORS['commerce.budget_check']!({
      env,
      node: n,
      config: withDefaults('commerce.budget_check', { source: 'company', commit: true }),
      ctx,
      stepKey,
    });
  };

  it('judges the budget as the first attempt did and records once, though its own spend now fills it', async () => {
    const c = await company();
    // Exactly one order of 600 fits: the retry sees the budget full of its own spend.
    const strict = await budget(c.id, { enforcement: 'strict', amount: 600 });
    const o = orderFor(c.id);
    const first = await check(o, 'budget#1');
    const again = await check(o, 'budget#1');
    expect(first.branches).toEqual(['within']);
    expect(again.branches).toEqual(['within']);
    expect(await spent(strict)).toBe(600);
    // Another order is over, as it should be.
    expect((await check(orderFor(c.id), 'budget#1')).branches).toEqual(['over']);
  });
});

describe('the budget tools over REST', () => {
  it('adds, lists with spend, changes and moves a budget', async () => {
    const op = staff('operator');
    const c = await company();
    const added = (await run(
      'put_budget',
      {
        companyId: c.id,
        name: 'Office',
        amount: 800,
        period: 'monthly',
        enforcement: 'strict',
        teamId: c.outer,
        startsOn: '2026-01-01',
      },
      op,
    )) as { ok: true; value: { id: string; done: string } };
    expect(added).toMatchObject({ ok: true, value: { done: 'Saved budget Office' } });
    const id = added.value.id;
    expect(await budgets().budget(ALL, id)).toMatchObject({
      name: 'Office',
      amount: 800,
      period: 'monthly',
      teamId: c.outer,
      enforcement: 'strict',
      status: 'active',
      anchor: Date.UTC(2026, 0, 1),
    });

    // Spend in the current window shows on the list, with what is left.
    const window = (await import('@commerceworker/core')).budgetWindow(
      'monthly',
      Date.UTC(2026, 0, 1),
      Date.now(),
    )!;
    await budgets().commit({
      orderId: 'ord_rest',
      stepKey: 'budget#1',
      at: 1,
      lines: [{ budgetId: id, amount: 300, window }],
    });
    const viewer = staff('viewer');
    expect(await run('list_budgets', { companyId: c.id }, viewer)).toMatchObject({
      ok: true,
      value: {
        total: 1,
        cursor: null,
        budgets: [
          {
            id,
            name: 'Office',
            spent: 300,
            remaining: 500,
            window: { start: window.start, end: window.end },
          },
        ],
      },
    });

    // A change keeps the budget's company, team, period and start.
    expect(
      await run('put_budget', { companyId: c.id, budgetId: id, name: 'Office 2', amount: 900 }, op),
    ).toMatchObject({ ok: true });
    expect(await budgets().budget(ALL, id)).toMatchObject({
      name: 'Office 2',
      amount: 900,
      enforcement: 'strict',
      period: 'monthly',
    });
    // A repeat changes nothing and the preview says so.
    expect(
      await run('put_budget', { companyId: c.id, budgetId: id, name: 'Office 2', amount: 900 }, op),
    ).toEqual({ ok: false, error: 'Nothing to change.' });

    expect(
      await run('set_budget_status', { companyId: c.id, budgetId: id, status: 'paused' }, op),
    ).toMatchObject({ ok: true });
    expect(
      await run('set_budget_status', { companyId: c.id, budgetId: id, status: 'paused' }, op),
    ).toEqual({ ok: false, error: 'It is already paused.' });
    expect(
      await run('set_budget_status', { companyId: c.id, budgetId: id, status: 'archived' }, op),
    ).toMatchObject({ ok: true });
    expect(
      await run('set_budget_status', { companyId: c.id, budgetId: id, status: 'active' }, op),
    ).toEqual({ ok: false, error: 'Office 2 is archived, which is final.' });
    expect(
      await run('put_budget', { companyId: c.id, budgetId: id, name: 'X', amount: 1 }, op),
    ).toEqual({ ok: false, error: 'Office 2 is archived, which is final.' });
  });

  it('holds the caller to a role, the schema and the rules, and never shows another company’s budget', async () => {
    const c = await company();
    const other = await company();
    const theirs = await budget(other.id);
    expect(
      await run(
        'put_budget',
        { companyId: c.id, name: 'X', amount: 5, period: 'weekly' },
        staff('viewer'),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await run(
        'put_budget',
        { companyId: c.id, name: 'X', amount: -5, period: 'weekly' },
        staff('operator'),
      ),
    ).toMatchObject({ ok: false, status: 400 });
    const op = staff('operator');
    expect(await run('put_budget', { companyId: c.id, name: 'X', amount: 5 }, op)).toEqual({
      ok: false,
      error: 'period: a new budget needs a period.',
    });
    expect(
      await run(
        'put_budget',
        { companyId: c.id, name: 'X', amount: 5, period: 'weekly', teamId: 'nope' },
        op,
      ),
    ).toEqual({ ok: false, error: 'No such team in this company.' });
    expect(
      await run(
        'put_budget',
        { companyId: 'cus_nobody', name: 'X', amount: 5, period: 'weekly' },
        op,
      ),
    ).toEqual({ ok: false, error: 'No such company.' });
    // Another company's budget is not this company's to change or move.
    expect(
      await run(
        'put_budget',
        { companyId: c.id, budgetId: theirs.id, name: 'Mine', amount: 5 },
        op,
      ),
    ).toEqual({ ok: false, error: 'No such budget.' });
    expect(
      await run(
        'set_budget_status',
        { companyId: c.id, budgetId: theirs.id, status: 'paused' },
        op,
      ),
    ).toEqual({ ok: false, error: 'No such budget.' });
    expect((await budgets().budget(ALL, theirs.id))?.status).toBe('active');
    expect(await run('list_budgets', { companyId: c.id }, op)).toMatchObject({
      ok: true,
      value: { total: 0, budgets: [] },
    });
    expect(await run('list_budgets', { companyId: c.id, cursor: 'junk' }, op)).toEqual({
      ok: false,
      error: 'That cursor isn’t one a page returned.',
    });
    // The period and team are fixed once there is a ledger to count in them.
    const mine = await budget(c.id, { period: 'monthly' });
    expect(
      await run(
        'put_budget',
        { companyId: c.id, budgetId: mine.id, name: 'M', amount: 5, period: 'weekly' },
        op,
      ),
    ).toEqual({ ok: false, error: 'A budget’s period can’t change: add a new budget instead.' });
    // An API token (not a person) may use them: none changes what a buyer pays.
    for (const tool of ['put_budget', 'set_budget_status'])
      expect(PERSON_CONFIRMS_TOOLS).not.toContain(tool);
  });
});

describe('the budget changes through the assistant', () => {
  it('previews each change with its refusal, without changing anything', async () => {
    const p = principal('operator');
    const c = await company();
    const b = await budget(c.id, { name: 'Travel' });
    const add = await previewAction(env, p, 'put_budget', {
      companyId: c.id,
      name: 'Fuel',
      amount: 250,
      period: 'quarterly',
      enforcement: 'strict',
    });
    expect(add).toMatchObject({
      title: expect.stringContaining('Add budget Fuel'),
      consequences: expect.arrayContaining([
        expect.stringContaining('250 USD a quarter'),
        expect.stringContaining('Strict: an order that would take it below zero is declined'),
      ]),
    });
    expect(add.blocked).toBeUndefined();
    const pause = await previewAction(env, p, 'set_budget_status', {
      companyId: c.id,
      budgetId: b.id,
      status: 'archived',
    });
    expect(pause.consequences.join('\n')).toContain('Final');
    expect(
      await previewAction(env, principal('viewer'), 'set_budget_status', {
        companyId: c.id,
        budgetId: b.id,
        status: 'paused',
      }),
    ).toMatchObject({ blocked: 'This needs the Operator role.' });
    expect((await budgets().budget(ALL, b.id))?.status).toBe('active');
    expect((await budgets().budgets(ALL, { companyId: c.id, limit: 10 })).total).toBe(1);
  });

  it('runs a confirmed change once and audits it', async () => {
    const p = principal('operator');
    const c = await company();
    const r = (await runAction(
      env,
      p,
      'put_budget',
      { companyId: c.id, name: 'Audited', amount: 40, period: 'weekly' },
      'MCP',
    )) as { id: string; done: string };
    expect(r.done).toBe('Saved budget Audited');
    await runAction(
      env,
      p,
      'set_budget_status',
      { companyId: c.id, budgetId: r.id, status: 'paused' },
      'MCP',
    );
    const audit = await env.DB.prepare(
      "SELECT action FROM audit_events WHERE target = ? AND action LIKE 'budget.%' ORDER BY at",
    )
      .bind(r.id)
      .all<{ action: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(['budget.saved', 'budget.status_changed']);
  });
});
