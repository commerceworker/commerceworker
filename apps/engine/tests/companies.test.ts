/**
 * Companies in the engine (docs/b2b.md, S1): the order's company and buyer held at validation
 * (`commerce.validate`), read by a flow as `company.*` and `buyer.*`, and the tools staff and
 * agents manage them with over REST's `runOperation` and MCP's confirmed calls.
 */
import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
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
import { ensureTemplates } from '../src/flows';
import { EXECUTORS } from '../src/nodes';
import { startOrder } from '../src/orders';
import { companyDirectory } from '../src/wire';
import { signedActor } from './principal';

const ALL = { all: true } as const;
const dir = () => companyDirectory(env);
const suffix = () => crypto.randomUUID().slice(0, 8);

const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const staff = (role: Role): RpcActor =>
  ({ kind: 'staff', id: `usr_co_${role}`, name: `${role}@example.com`, role }) as RpcActor;
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
  id: `usr_co_${role}`,
  name: role,
  email: `${role}@example.com`,
  role,
});

/** A business customer with an active company, a team and two members. */
async function company(status: 'active' | 'suspended' = 'active') {
  const id = `cx_${suffix()}`;
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
    role: 'buyer' as const,
    teamId: null,
    status: 'active' as const,
    orderLimit: null,
    ...over,
  });
  await dir().upsertMembers(
    id,
    [
      member('ann', { role: 'approver', teamId: `${id}_t`, orderLimit: 750 }),
      member('bo', { status: 'inactive' }),
    ],
    1,
  );
  return { id, ann: `${id}_ann`, bo: `${id}_bo` };
}

const orderOf = (customerId: string, meta: Record<string, unknown> = {}): Order => ({
  id: `ord_co_${suffix()}`,
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  customerId,
  lines: [{ sku: 'BRG-608', qty: 1 }],
  meta,
  createdAt: 0,
  subtotal: 0,
  shipping: 0,
  tax: 0,
  total: 0,
  fxRate: 1,
});

/** Runs the validate node on `o`, as its step would. */
function validate(o: Order) {
  const ctx: RunContext = { order: o, nodes: {}, vars: {}, input: {}, now: 0, ref: o.id };
  const node: FlowNode = {
    id: 'v',
    type: 'commerce.validate',
    label: 'v',
    config: {},
    position: { x: 0, y: 0 },
  };
  return EXECUTORS['commerce.validate']!({
    env,
    node,
    config: withDefaults('commerce.validate', {}),
    ctx,
    stepKey: 'validate#1',
  });
}

beforeAll(async () => {
  await ensureTemplates(env);
});

describe('commerce.validate holds an order to its company and buyer', () => {
  it('accepts an active company’s order, with or without an active member as the buyer', async () => {
    const c = await company();
    expect(await validate(orderOf(c.id))).toMatchObject({ order: { lines: [{ sku: 'BRG-608' }] } });
    expect(await validate(orderOf(c.id, { buyerId: c.ann }))).toMatchObject({
      summary: expect.stringContaining('1 line'),
    });
  });

  it('declines an order from a company that isn’t active', async () => {
    const c = await company('suspended');
    await expect(validate(orderOf(c.id))).rejects.toThrow(
      `Company ${c.id} isn't active (suspended)`,
    );
  });

  it('declines a buyer who isn’t an active member of the customer', async () => {
    const c = await company();
    const other = await company();
    const refused = `Buyer %s isn't an active member of ${c.id}`;
    // Inactive, unknown, a member of another company, and removed.
    await expect(validate(orderOf(c.id, { buyerId: c.bo }))).rejects.toThrow(
      refused.replace('%s', c.bo),
    );
    await expect(validate(orderOf(c.id, { buyerId: 'mem_ghost' }))).rejects.toThrow('mem_ghost');
    await expect(validate(orderOf(c.id, { buyerId: other.ann }))).rejects.toThrow(
      refused.replace('%s', other.ann),
    );
    await dir().transitionMember(ALL, c.id, c.ann, 'active', 'removed', 2);
    await expect(validate(orderOf(c.id, { buyerId: c.ann }))).rejects.toThrow(
      refused.replace('%s', c.ann),
    );
    // A buyer on an order whose customer has no company.
    await expect(validate(orderOf('cus_ada', { buyerId: c.ann }))).rejects.toThrow(
      "isn't an active member of cus_ada",
    );
  });

  it('leaves a consumer’s order alone', async () => {
    expect(await validate(orderOf('cus_ada'))).toMatchObject({
      order: { lines: [{ sku: 'BRG-608' }] },
    });
  });
});

describe('a flow reads company.* and buyer.*', () => {
  const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
    id,
    type,
    label: id,
    config,
    position: { x: 0, y: 0 },
  });
  const edge = (source: string, target: string) => ({
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle: null,
    targetHandle: null,
  });
  let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;

  beforeAll(async () => {
    await publishFlow(createDb(env.DB), {
      id: 'test-company-context',
      name: 'Company context',
      description: '',
      model: 'b2b',
      channels: [],
      nodes: [
        node('start', 'trigger.manual'),
        node('validate', 'commerce.validate'),
        node('read', 'control.set', {
          assign: {
            status: { var: 'company.status' },
            tier: { var: 'company.tier' },
            role: { var: 'buyer.role' },
            team: { var: 'buyer.team' },
            limit: { var: 'buyer.orderLimit' },
          },
        }),
        node('done', 'control.end', { outcome: 'completed', reason: 'read' }),
      ],
      edges: [edge('start', 'validate'), edge('validate', 'read'), edge('read', 'done')],
    });
  });
  afterEach(async () => {
    await introspector?.dispose();
  });

  const input = (customerId: string, meta: Record<string, unknown>): OrderInput => ({
    model: 'b2b',
    channel: 'api',
    currency: 'USD',
    customerId,
    lines: [{ sku: 'BRG-608', qty: 1 }],
    meta,
  });
  const settled = async (orderId: string) => {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const s = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
      if (['completed', 'failed', 'declined', 'rolled_back'].includes(s.status)) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Timed out waiting for the order to settle');
  };

  it('reads the company’s status and tier and the buyer’s role, team and own limit', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => m.disableRetryDelays());
    const c = await company();
    const { orderId } = await startOrder(env, {
      flowId: 'test-company-context',
      input: input(c.id, { buyerId: c.ann }),
    });
    const s = await settled(orderId);
    expect(s.status).toBe('completed');
    expect(s.vars).toMatchObject({
      status: 'active',
      tier: 'gold',
      role: 'approver',
      team: `${c.id}_t`,
      limit: 750,
    });
  });

  it('reads null for what an order has no buyer for, and fails a suspended company’s order at validate', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => m.disableRetryDelays());
    const c = await company();
    const noBuyer = await settled(
      (await startOrder(env, { flowId: 'test-company-context', input: input(c.id, {}) })).orderId,
    );
    expect(noBuyer.vars).toMatchObject({ status: 'active', role: null, team: null, limit: null });

    const held = await company('suspended');
    const declined = await settled(
      (await startOrder(env, { flowId: 'test-company-context', input: input(held.id, {}) }))
        .orderId,
    );
    expect(declined.status).toBe('failed');
    expect(JSON.stringify(declined)).toContain("isn't active (suspended)");
  });

  it('records who placed the order, and rejects a malformed buyer id at the door', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => m.disableRetryDelays());
    const c = await company();
    const { orderId } = await startOrder(env, {
      flowId: 'test-company-context',
      input: input(c.id, { buyerId: c.ann }),
    });
    const row = await env.DB.prepare('SELECT buyer_id FROM orders WHERE id = ?')
      .bind(orderId)
      .first<{ buyer_id: string | null }>();
    expect(row?.buyer_id).toBe(c.ann);
    await expect(
      startOrder(env, { flowId: 'test-company-context', input: input(c.id, { buyerId: 7 }) }),
    ).rejects.toThrow(/buyerId/);
  });
});

describe('the company tools over REST', () => {
  it('adds a customer with its company, and finds it, its members and its teams', async () => {
    const op = staff('operator');
    const name = `Acme ${suffix()}`;
    const created = (await run(
      'create_customer',
      { name, email: `${suffix()}@acme.test`, company: { taxId: 'GB1' } },
      op,
    )) as {
      ok: true;
      value: { id: string; done: string };
    };
    expect(created).toMatchObject({ ok: true, value: { done: `Added ${name}` } });
    const id = created.value.id;

    const listed = await run('list_companies', { search: name }, op);
    expect(listed).toMatchObject({
      ok: true,
      value: {
        total: 1,
        companies: [{ id, name, status: 'active', legalName: name, taxId: 'GB1' }],
      },
    });

    const team = (await run('put_company_team', { companyId: id, name: 'Buying' }, op)) as {
      ok: true;
      value: { id: string };
    };
    expect(team.ok).toBe(true);
    const put = await run(
      'put_company_members',
      {
        companyId: id,
        members: [
          {
            email: 'Ann@Acme.test',
            name: 'Ann',
            role: 'approver',
            teamId: team.value.id,
            status: 'active',
          },
          { email: 'bo@acme.test', name: 'Bo', orderLimit: 100 },
        ],
      },
      op,
    );
    expect(put).toMatchObject({ ok: true, value: { done: `2 added, 0 changed in ${name}` } });
    const company = (await run('get_company', { companyId: id }, op)) as {
      ok: true;
      value: { teams: { name: string }[] };
    };
    expect(company.value.teams.map((t) => t.name)).toEqual(['Buying']);
    const members = (await run(
      'list_company_members',
      { companyId: id, status: 'active' },
      op,
    )) as {
      ok: true;
      value: { total: number; members: { id: string; email: string; role: string }[] };
    };
    expect(members.value).toMatchObject({
      total: 1,
      members: [{ email: 'ann@acme.test', role: 'approver' }],
    });

    const bo = (
      (await run('list_company_members', { companyId: id, role: 'buyer' }, op)) as {
        value: { members: { id: string }[] };
      }
    ).value.members[0]!;
    expect(
      await run('remove_company_member', { companyId: id, memberId: bo.id }, op),
    ).toMatchObject({ ok: true });
    // A repeat is refused by the live preview, as over MCP: they are already removed.
    expect(await run('remove_company_member', { companyId: id, memberId: bo.id }, op)).toEqual({
      ok: false,
      error: 'They are already removed.',
    });
    expect(
      await run('set_company_status', { companyId: id, status: 'suspended' }, op),
    ).toMatchObject({ ok: true });
    expect(await run('set_company_status', { companyId: id, status: 'pending' }, op)).toMatchObject(
      {
        ok: false,
        error: expect.stringContaining('can’t become pending'),
      },
    );
    expect(await run('update_customer', { customerId: id, tier: 'gold' }, op)).toMatchObject({
      ok: true,
    });
    expect((await dir().customer(ALL, id))?.tier).toBe('gold');
  });

  it('holds the caller to a role, to the schema and to what the rules allow', async () => {
    expect(await run('list_companies', {}, staff('viewer'))).toEqual({
      ok: false,
      error: 'This needs the Operator role.',
    });
    expect(
      await run('create_customer', { name: 'X', email: 'x@x.test' }, staff('viewer')),
    ).toMatchObject({ ok: false });
    expect(
      await run('create_customer', { name: '', email: 'nope' }, staff('operator')),
    ).toMatchObject({ ok: false, status: 400 });
    expect(await run('get_company', { companyId: 'cus_ada' }, staff('operator'))).toEqual({
      ok: false,
      error: 'No such company.',
    });
    expect(await run('list_companies', { cursor: 'junk' }, staff('operator'))).toEqual({
      ok: false,
      error: 'That cursor isn’t one a page returned.',
    });
    // An API token (not a person) may use them: none changes what a buyer pays.
    for (const tool of [
      'create_customer',
      'update_customer',
      'set_company_status',
      'put_company_members',
      'remove_company_member',
      'put_company_team',
    ])
      expect(PERSON_CONFIRMS_TOOLS).not.toContain(tool);
  });
});

describe('the company changes through the assistant', () => {
  it('previews each change with its refusal, without changing anything', async () => {
    const p = principal('operator');
    const c = await company('suspended');
    const set = await previewAction(env, p, 'set_company_status', {
      companyId: c.id,
      status: 'closed',
    });
    expect(set).toMatchObject({
      title: expect.stringContaining('closed'),
      consequences: expect.arrayContaining([expect.stringContaining('Final')]),
    });
    expect(set.blocked).toBeUndefined();
    expect(
      await previewAction(env, p, 'set_company_status', { companyId: c.id, status: 'suspended' }),
    ).toMatchObject({
      blocked: expect.stringContaining('already suspended'),
    });
    expect(
      await previewAction(env, principal('viewer'), 'set_company_status', {
        companyId: c.id,
        status: 'closed',
      }),
    ).toMatchObject({
      blocked: 'This needs the Operator role.',
    });
    expect((await dir().company(ALL, c.id))?.status).toBe('suspended');
    const members = await previewAction(env, p, 'put_company_members', {
      companyId: c.id,
      members: [{ email: 'new@x.test', name: 'N' }],
    });
    // A card says how many and what a member can do, not who.
    expect(JSON.stringify(members)).not.toContain('new@x.test');
    expect(members.consequences[0]).toBe('1 added, 0 changed');
    expect(
      await previewAction(env, p, 'create_customer', {
        name: 'Dup',
        email: `${c.id}@example.test`,
        kind: 'business',
        tier: 'standard',
        terms: 'net_30',
      }),
    ).toMatchObject({
      blocked: expect.stringContaining('already exists'),
    });
  });

  it('runs a confirmed change once, and audits it without a name or email', async () => {
    const p = principal('operator');
    const c = await company();
    const r = (await runAction(
      env,
      p,
      'set_company_status',
      { companyId: c.id, status: 'suspended' },
      'MCP',
    )) as {
      done: string;
    };
    expect(r.done).toContain('suspended');
    expect((await dir().company(ALL, c.id))?.status).toBe('suspended');
    await runAction(
      env,
      p,
      'put_company_members',
      { companyId: c.id, members: [{ email: 'secret@person.test', name: 'Secret Person' }] },
      'MCP',
    );
    const audit = await env.DB.prepare(
      "SELECT action, detail FROM audit_events WHERE target = ? AND action LIKE 'company.%' ORDER BY at",
    )
      .bind(c.id)
      .all<{ action: string; detail: string }>();
    expect(audit.results.map((a) => a.action)).toEqual([
      'company.status_changed',
      'company.members_saved',
    ]);
    expect(JSON.stringify(audit.results)).not.toContain('secret@person.test');
    expect(JSON.stringify(audit.results)).not.toContain('Secret Person');
  });
});
