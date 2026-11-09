/**
 * `EngineApi.runOperation`: what the REST API runs a workspace tool through. It must hold a REST
 * caller to exactly what MCP holds an MCP client to: the call signed for that one operation, the
 * tool's input schema and role, an action's live preview and refusals, and the page's and panel's
 * tools out of reach.
 */
import { env } from 'cloudflare:workers';
import { PERSON_VERIFIES, type Role, type RpcActor } from '@commerceworker/core';
import { createDb, customers } from '@commerceworker/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { ensureTemplates } from '../src/flows';
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
const run = async (tool: string, input: unknown, actor: RpcActor, call = `operation:${tool}`) =>
  api().runOperation(tool, input, await signedActor(actor, call));

beforeAll(async () => {
  await ensureTemplates(env);
});

describe('running a workspace tool for the REST API', () => {
  it('runs it signed for that operation, and refuses anything else', async () => {
    const r = await run('run_stock_review', {}, staff('operator'));
    expect(r).toMatchObject({ ok: true, value: { instanceId: expect.any(String) } });
    expect(
      await run('run_stock_review', {}, staff('operator'), 'operation:publish_flow'),
    ).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await api().runOperation('run_stock_review', {}, 'nope')).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await run('no_such_tool', {}, staff('admin'))).toMatchObject({ ok: false, status: 404 });
  });

  it("holds the caller to the tool's role and input", async () => {
    expect(await run('run_stock_review', {}, staff('viewer'))).toEqual({
      ok: false,
      error: 'This needs the Operator role.',
    });
    const bad = await run(
      'set_promotion_status',
      { promotionId: 'pr_x', status: 'gone' },
      staff('operator'),
    );
    expect(bad).toMatchObject({ ok: false, status: 400 });
    expect((bad as { error: string }).error).toMatch(/^status:/);
  });

  it("keeps the page's and the panel's tools out of reach, as over MCP", async () => {
    expect(
      await run('set_member_role', { userId: 'usr_x', role: 'admin' }, staff('admin')),
    ).toEqual({
      ok: false,
      error: 'This is changed only in the app, by a person signed in.',
    });
    const page = await run('accept_product_drafts', { keys: ['x'] }, staff('admin'));
    expect(page).toMatchObject({ ok: false });
  });

  it('lets only a person verify a tax certificate, as over MCP', async () => {
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
    expect(await run('verify_tax_certificate', input, checker)).toEqual({
      ok: false,
      error: PERSON_VERIFIES,
    });
    const r = await run('verify_tax_certificate', input, { ...checker, person: true } as RpcActor);
    expect(r).toMatchObject({ ok: true, value: { id: certificateId } });
  });
});
