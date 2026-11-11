import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { type CheckoutSession, newId, type OrderState } from '@commerceworker/core';
import { orders } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutCaller } from '../src/checkout/caller';
import { completeSession } from '../src/checkout/complete';
import { current, load } from '../src/checkout/session';
import { ensureTemplates, loadFlowVersion } from '../src/flows';
import { checkoutSessions } from '../src/wire';
import { db, enableUcp, key, monitorCheckout, pay, platform, ucp } from './ucp-helpers';

// The checkout behind UCP is not UCP's: another caller names its own owner, channel and
// idempotency prefix, and the module holds it to them.
const hosted: CheckoutCaller = {
  ownerId: 'shopper_1',
  channel: 'web',
  idempotencyPrefix: 'hosted',
  meta: { hosted: { page: 'checkout' } },
};

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeAll(async () => {
  await ensureTemplates(env);
  await enableUcp();
});
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

/** A priced, ready session the hosted caller owns (a UCP checkout's, handed to another owner). */
async function hostedSession(): Promise<CheckoutSession> {
  const alpha = await platform('alpha');
  const { body } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
  const s = (await load(env, { ...hosted, ownerId: 'alpha' }, body.id))!;
  const mine = { ...s, id: newId('chk'), ownerId: hosted.ownerId };
  await checkoutSessions(env).create(mine);
  return mine;
}

const authorize = async () => ({ ok: true as const });

describe('checkout caller seam', () => {
  it('loads a session only for its owner', async () => {
    const s = await hostedSession();
    expect((await current(env, hosted, s.id))?.id).toBe(s.id);
    expect(await current(env, { ...hosted, ownerId: 'shopper_2' }, s.id)).toBeNull();
    expect(await load(env, { ...hosted, ownerId: 'alpha' }, s.id)).toBeNull();
  });

  it("starts the order under the caller's own channel, prefix and meta", async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const s = await hostedSession();
    const flow = (await loadFlowVersion(env, 'tpl-storefront-order'))!;
    const done = await completeSession(env, hosted, flow, s, { refusal: null, authorize });
    if (done.kind !== 'session') throw new Error('lost the race');
    expect(done.session.status).toBe('completed');

    const row = await db().select().from(orders).where(eq(orders.id, done.session.orderId!)).get();
    expect(row).toMatchObject({
      channel: 'web',
      externalId: s.id,
      idempotencyKey: `hosted:${s.id}`,
      startedBy: 'shopper_1',
    });
    const state = (await env.ORDER_AGENT.getByName(row!.id).snapshot()) as OrderState;
    expect(state.order!.meta).toMatchObject({ hosted: { page: 'checkout' } });
    expect(state.order!.meta).not.toHaveProperty('ucp');
  });

  it('keeps UCP on the agent channel with its own prefix', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const alpha = await platform('alpha');
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const done = await ucp(alpha, 'POST', `/ucp/v1/checkout-sessions/${c.id}/complete`, pay(), {
      'idempotency-key': key(),
    });
    const row = await db().select().from(orders).where(eq(orders.id, done.body.order.id)).get();
    expect(row).toMatchObject({ channel: 'agent', idempotencyKey: `ucp:${c.id}` });
  });

  it('shows a refusal without claiming the session, and reopens it when the processor fails', async () => {
    const s = await hostedSession();
    const flow = (await loadFlowVersion(env, 'tpl-storefront-order'))!;
    const refused = await completeSession(env, hosted, flow, s, {
      refusal: { code: 'payment_failed', content: 'No instrument.' },
      authorize,
    });
    expect(refused).toMatchObject({
      kind: 'session',
      session: { status: 'ready_for_complete', issues: [{ code: 'payment_failed' }] },
    });

    const again = (await current(env, hosted, s.id))!;
    await expect(
      completeSession(env, hosted, flow, again, {
        refusal: null,
        authorize: async () => {
          throw new Error('processor down');
        },
      }),
    ).rejects.toThrow('processor down');
    expect((await current(env, hosted, s.id))?.status).toBe('ready_for_complete');
  });

  it('reports a lost race instead of writing over the winner', async () => {
    const s = await hostedSession();
    const flow = (await loadFlowVersion(env, 'tpl-storefront-order'))!;
    // Someone wrote after this caller read.
    await checkoutSessions(env).save({ ...s, version: s.version + 1 }, s.version);
    expect(await completeSession(env, hosted, flow, s, { refusal: null, authorize })).toEqual({
      kind: 'raced',
    });
  });
});
