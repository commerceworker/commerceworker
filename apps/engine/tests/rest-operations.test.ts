/**
 * `EngineApi.runOperation`: what the REST API runs a workspace tool through. It must hold a REST
 * caller to exactly what MCP holds an MCP client to: the call signed for that one operation and
 * input, the tool's input schema and role, an action's live preview and refusals, the tools REST
 * offers and no others, and a person for what a person always confirms.
 */
import { env } from 'cloudflare:workers';
import { listAuditEvents } from '@commerceworker/application/commerce';
import { operationCall, PERSON_CONFIRMS, type Role, type RpcActor } from '@commerceworker/core';
import { createDb, customers } from '@commerceworker/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { DRAFT_CHANGED } from '../src/assistant/flows';
import { ensureTemplates } from '../src/flows';
import { auditLog } from '../src/wire';
import { signedActor } from './principal';

const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const staff = (role: Role, over: Partial<RpcActor> = {}): RpcActor =>
  ({
    kind: 'staff',
    id: `usr_ops_${role}`,
    name: `${role}@example.com`,
    role,
    ...over,
  }) as RpcActor;
const person = (role: Role) => staff(role, { person: true } as Partial<RpcActor>);
const run = async (tool: string, input: unknown, actor: RpcActor, call?: string) =>
  api().runOperation(
    tool,
    input,
    await signedActor(actor, call ?? (await operationCall(tool, input))),
  );

beforeAll(async () => {
  await ensureTemplates(env);
});

describe('running a workspace tool for the REST API', () => {
  it('runs it signed for that operation and input, and refuses anything else', async () => {
    const r = await run('run_stock_review', {}, staff('operator'));
    expect(r).toMatchObject({ ok: true, value: { instanceId: expect.any(String) } });
    // Signed for another tool, or for this one with other input, it does nothing.
    const other = await operationCall('get_flow', { flowId: 'tpl-b2b-order' });
    expect(await run('run_stock_review', {}, staff('operator'), other)).toMatchObject({
      ok: false,
      status: 403,
    });
    const otherInput = await operationCall('run_stock_review', { x: 1 });
    expect(await run('run_stock_review', {}, staff('operator'), otherInput)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await api().runOperation('run_stock_review', {}, 'nope')).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await run('no_such_tool', {}, staff('admin'))).toMatchObject({ ok: false, status: 404 });
  });

  it('names an OAuth app in the trail of what it does, and no one else', async () => {
    const reviews = async () =>
      (await listAuditEvents({ audit: auditLog(env) }, { limit: 500 })).filter(
        (e) => e.action === 'stock.review_run',
      );
    const before = (await reviews()).length;
    await run(
      'run_stock_review',
      {},
      staff('operator', {
        name: 'app@example.com',
        grant: 'grant_1',
        client: 'client_1',
      } as Partial<RpcActor>),
    );
    await run('run_stock_review', {}, staff('operator', { name: 'tok@example.com' }));
    const mine = await reviews();
    expect(mine.length).toBe(before + 2);
    const app = mine.find((e) => e.actor === 'app@example.com');
    const token = mine.find((e) => e.actor === 'tok@example.com');
    expect(app?.detail).toMatchObject({ via: 'api', grant: 'grant_1', client: 'client_1' });
    expect(token?.detail).not.toHaveProperty('grant');
  });

  it("holds the caller to the tool's role and input", async () => {
    expect(await run('run_stock_review', {}, staff('viewer'))).toEqual({
      ok: false,
      error: 'This needs the Operator role.',
    });
    const bad = await run(
      'set_promotion_status',
      { promotionId: 'pr_x', status: 'gone' },
      person('operator'),
    );
    expect(bad).toMatchObject({ ok: false, status: 400 });
    expect((bad as { error: string }).error).toMatch(/^status:/);
  });

  it('reads the stock list for a viewer, and bounds what reaches the model', async () => {
    const r = await run('find_products', { belowReorder: false }, staff('viewer'));
    expect(r).toMatchObject({ ok: true });
    const long = await run('draft_plugin', { instruction: 'x'.repeat(4001) }, staff('admin'));
    expect(long).toMatchObject({ ok: false, status: 400 });
    expect((long as { error: string }).error).toMatch(/^instruction:/);
  });

  it('runs only the tools REST offers: not the page’s or the panel’s', async () => {
    for (const [tool, input] of [
      ['set_member_role', { userId: 'usr_x', role: 'admin' }],
      ['accept_product_drafts', { keys: ['x'] }],
      // MCP offers it; REST has its own route, and the engine holds that too.
      ['cancel_order', { orderId: 'ord_x', reason: 'x' }],
    ] as const)
      expect(await run(tool, input, person('admin'))).toMatchObject({ ok: false, status: 404 });
  });

  it('publishes only the draft its caller read', async () => {
    const op = staff('operator');
    const copy = (await run('duplicate_flow', { flowId: 'tpl-b2b-order' }, op)) as {
      ok: true;
      value: { id: string };
    };
    const flowId = copy.value.id;
    const read = (await run('get_flow', { flowId }, op)) as { ok: true; value: { draft: string } };
    expect(read.value.draft).toMatch(/^[0-9a-f]{64}$/);
    expect(await run('publish_flow', { flowId }, op)).toMatchObject({ ok: false, status: 400 });
    expect(await run('publish_flow', { flowId, draft: 'f'.repeat(64) }, op)).toEqual({
      ok: false,
      error: DRAFT_CHANGED,
    });
    expect(await run('publish_flow', { flowId, draft: read.value.draft }, op)).toMatchObject({
      ok: true,
      value: { version: 1 },
    });
  });

  it('never lets a token change what buyers pay or owe, as A2A never does', async () => {
    const promo = { code: 'REST10', kind: 'pct', value: 10 };
    expect(await run('create_promotion', promo, staff('operator'))).toEqual({
      ok: false,
      status: 403,
      error: PERSON_CONFIRMS,
    });
    const status = { promotionId: 'pr_x', status: 'active' };
    expect(await run('set_promotion_status', status, staff('operator'))).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await run('create_promotion', promo, person('operator'))).toMatchObject({ ok: true });
  });

  it('lists exchange rates for an operator, and lets only a person set one', async () => {
    expect(await run('list_fx_rates', {}, staff('viewer'))).toEqual({
      ok: false,
      error: 'This needs the Operator role.',
    });
    expect(await run('list_fx_rates', {}, staff('operator'))).toMatchObject({
      ok: true,
      value: { base: 'USD', rates: expect.any(Array) },
    });
    const input = { currency: 'EUR', rate: 0.9 };
    // A token, even an admin's, never changes what buyers pay.
    expect(await run('set_fx_rate', input, staff('admin'))).toEqual({
      ok: false,
      status: 403,
      error: PERSON_CONFIRMS,
    });
    expect(await run('set_fx_rate', input, person('operator'))).toEqual({
      ok: false,
      error: 'This needs the Admin role.',
    });
    expect(await run('set_fx_rate', input, person('admin'))).toMatchObject({
      ok: true,
      value: { id: 'EUR' },
    });
    expect(await run('set_fx_rate', { currency: 'USD', rate: 1 }, person('admin'))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/base currency/),
    });
  });

  it('reads a credit account for a viewer, and lets only an admin person change it', async () => {
    const id = `cus_ops_credit_${crypto.randomUUID().slice(0, 8)}`;
    await createDb(env.DB)
      .insert(customers)
      .values({
        id,
        name: `Credit ${id}`,
        email: `${id}@example.com`,
        kind: 'business',
        creditLimit: 500,
        balance: 50,
      });
    expect(await run('get_credit_account', { customerId: id }, staff('viewer'))).toMatchObject({
      ok: true,
      value: { limit: 500, balance: 50, held: 0, available: 450, entries: [], next: null },
    });
    expect(await run('get_credit_account', { customerId: 'cus_nobody' }, staff('viewer'))).toEqual({
      ok: false,
      error: 'No such customer.',
    });
    const limit = { customerId: id, limit: 800 };
    const adjust = { customerId: id, amount: -20, reason: 'Credit memo 3' };
    // A token never changes what a customer owes, even an admin's.
    for (const [tool, input] of [
      ['set_credit_limit', limit],
      ['adjust_credit', adjust],
    ] as const) {
      expect(await run(tool, input, staff('admin'))).toEqual({
        ok: false,
        status: 403,
        error: PERSON_CONFIRMS,
      });
      expect(await run(tool, input, person('operator'))).toEqual({
        ok: false,
        error: 'This needs the Admin role.',
      });
    }
    expect(await run('set_credit_limit', limit, person('admin'))).toMatchObject({
      ok: true,
      value: { id },
    });
    // A retried REST call with the same Idempotency-Key records one adjustment.
    const call = async () =>
      api().runOperation(
        'adjust_credit',
        adjust,
        await signedActor(person('admin'), await operationCall('adjust_credit', adjust)),
        'retry-1',
      );
    expect(await call()).toMatchObject({ ok: true });
    expect(await call()).toMatchObject({ ok: true });
    expect(await run('get_credit_account', { customerId: id }, staff('viewer'))).toMatchObject({
      ok: true,
      value: {
        limit: 800,
        balance: 30,
        entries: [{ kind: 'adjust', amount: -20, balanceAfter: 30, note: 'Credit memo 3' }],
      },
    });
    expect(await run('adjust_credit', { ...adjust, reason: '' }, person('admin'))).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('lets only a person verify or revoke a tax certificate, as over MCP', async () => {
    const id = `cus_ops_${crypto.randomUUID().slice(0, 8)}`;
    await createDb(env.DB)
      .insert(customers)
      .values({ id, name: `Exempt ${id}`, email: `${id}@example.com`, kind: 'business' });
    const certificateId = `txc_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const added = await api().addTaxCertificate(
      id,
      {
        id: certificateId,
        number: 'RS-5555',
        regions: [{ country: 'US', region: 'CA' }],
        expiresAt: null,
        file: null,
      },
      await signedActor(staff('operator'), `tax-certificates:${id}`),
    );
    expect(added).toMatchObject({ ok: true });
    const input = { customerId: id, certificateId };
    const checker = staff('operator', { id: 'usr_ops_checker', name: 'checker@example.com' });
    for (const tool of ['verify_tax_certificate', 'revoke_tax_certificate'])
      expect(await run(tool, input, checker)).toEqual({
        ok: false,
        status: 403,
        error: PERSON_CONFIRMS,
      });
    const r = await run('verify_tax_certificate', input, {
      ...checker,
      person: true,
    } as RpcActor);
    expect(r).toMatchObject({ ok: true, value: { id: certificateId } });
  });
});
