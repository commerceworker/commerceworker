import { env } from 'cloudflare:workers';
import {
  createDb,
  inboundEmails,
  nodeRuns,
  paymentEvents,
  sessions,
  users,
  webhookDeliveries,
  webhookReceipts,
} from '@commerceworker/db';
import { inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { expireIntake, expirePluginExports, RETENTION, sweep } from '../src/retention';

const db = () => createDb(env.DB);
const DAY = 86_400_000;

describe('retention sweep', () => {
  it('deletes what is past its retention and keeps the rest', async () => {
    const now = Date.now();
    await db()
      .insert(users)
      .values({
        id: 'usr_ret',
        email: 'ret@example.com',
        name: 'ret',
        role: 'viewer',
        createdAt: 0,
      })
      .onConflictDoNothing();
    await db()
      .insert(sessions)
      .values([
        { tokenHash: 'ret-expired', userId: 'usr_ret', createdAt: 0, expiresAt: now - 1 },
        { tokenHash: 'ret-live', userId: 'usr_ret', createdAt: 0, expiresAt: now + DAY },
      ]);
    const delivery = (id: string, createdAt: number, status: string) => ({
      id,
      subscriptionId: 'sub_ret',
      orderId: 'ord_ret',
      event: 'order.completed',
      payload: '{}',
      status,
      createdAt,
    });
    const old = now - RETENTION.webhookDeliveriesMs - DAY;
    await db()
      .insert(webhookDeliveries)
      .values([
        delivery('whd_ret_old', old, 'delivered'),
        delivery('whd_ret_pending', old, 'pending'),
        delivery('whd_ret_new', now, 'delivered'),
      ]);
    const run = (nodeId: string, endedAt: number) => ({
      orderId: 'ord_ret',
      generation: 1,
      nodeId,
      run: 1,
      nodeType: 'commerce.validate',
      model: 'b2b',
      status: 'succeeded',
      startedAt: endedAt,
      endedAt,
      durationMs: 1,
    });
    await db()
      .insert(nodeRuns)
      .values([run('old', now - RETENTION.nodeRunsMs - DAY), run('new', now)]);
    const email = (id: string, receivedAt: number) => ({
      id,
      messageId: `<${id}>`,
      mailbox: 'orders@example.com',
      sender: 'a@example.com',
      status: 'rejected',
      receivedAt,
    });
    await db()
      .insert(inboundEmails)
      .values([
        email('eml_ret_old', now - RETENTION.inboundEmailsMs - DAY),
        email('eml_ret_new', now),
      ]);
    await db()
      .insert(webhookReceipts)
      .values([
        { id: 'event:ret-old', receivedAt: now - RETENTION.webhookReceiptsMs - 1 },
        { id: 'event:ret-new', receivedAt: now },
      ]);
    const event = (id: string, receivedAt: number) => ({
      id,
      provider: 'stripe',
      type: 'invoice.paid',
      receivedAt,
    });
    await db()
      .insert(paymentEvents)
      .values([
        event('evt_ret_old', now - RETENTION.paymentEventsMs - 1),
        event('evt_ret_new', now - 3 * DAY),
      ]);

    const swept = await sweep(env, now);
    expect(swept).toMatchObject({
      sessions: expect.any(Number),
      webhookDeliveries: 1,
      nodeRuns: 1,
      inboundEmails: 1,
      webhookReceipts: 1,
      paymentEvents: 1,
    });

    const left = async <T extends { id: string }>(rows: Promise<T[]>) =>
      (await rows).map((r) => r.id).sort();
    expect(
      (
        await db()
          .select()
          .from(sessions)
          .where(inArray(sessions.tokenHash, ['ret-expired', 'ret-live']))
      ).map((s) => s.tokenHash),
    ).toEqual(['ret-live']);
    expect(
      await left(
        db()
          .select()
          .from(webhookDeliveries)
          .where(inArray(webhookDeliveries.id, ['whd_ret_old', 'whd_ret_pending', 'whd_ret_new'])),
      ),
    ).toEqual(['whd_ret_new', 'whd_ret_pending']);
    expect(
      (
        await db()
          .select()
          .from(nodeRuns)
          .where(inArray(nodeRuns.nodeId, ['old', 'new']))
      ).map((r) => r.nodeId),
    ).toEqual(['new']);
    expect(
      await left(
        db()
          .select()
          .from(inboundEmails)
          .where(inArray(inboundEmails.id, ['eml_ret_old', 'eml_ret_new'])),
      ),
    ).toEqual(['eml_ret_new']);
    expect(
      await left(
        db()
          .select()
          .from(paymentEvents)
          .where(inArray(paymentEvents.id, ['evt_ret_old', 'evt_ret_new'])),
      ),
    ).toEqual(['evt_ret_new']);
  });

  it('deletes a plugin’s uninstall export after 30 days, and a failure skips nothing else', async () => {
    await env.DOCS.put('plugin-exports/ret-plugin/a.ndjson', 'x');
    await env.DOCS.put('plugin-exports/ret-other/b.ndjson', 'y');
    const left = async () =>
      (await env.DOCS.list({ prefix: 'plugin-exports/' })).objects.map((o) => o.key);
    // Still within its window.
    expect(await expirePluginExports(env, Date.now() + 29 * DAY)).toBe(0);
    expect(await left()).toHaveLength(2);
    // The daily sweep reports them.
    expect((await sweep(env, Date.now() + 31 * DAY)).pluginExports).toBe(2);
    expect(await left()).toEqual([]);
    // A bucket that throws costs only this step.
    const broken = { ...env, DOCS: { list: () => Promise.reject(new Error('R2 is down')) } };
    expect(await expirePluginExports(broken as unknown as Env)).toBe(0);
  });

  it('deletes a raw intake body at 7 days, and a failure skips nothing else', async () => {
    await env.DOCS.put('intake/shopify/2026-01-01/ret-a', '{}');
    await env.DOCS.put('intake/edi/2026-01-01/ret-b', 'ISA');
    await env.DOCS.put('orders/ret-intake/keep.html', 'kept');
    const left = async () => (await env.DOCS.list({ prefix: 'intake/' })).objects.map((o) => o.key);
    // The boundary: just inside 7 days keeps both, just past it deletes both.
    expect(await expireIntake(env, Date.now() + 7 * DAY - 60_000)).toBe(0);
    expect(await left()).toHaveLength(2);
    expect((await sweep(env, Date.now() + 7 * DAY + 60_000)).intakeBodies).toBe(2);
    expect(await left()).toEqual([]);
    // Nothing outside intake/ is touched.
    expect(await env.DOCS.head('orders/ret-intake/keep.html')).not.toBeNull();
    // A bucket that throws costs only this step.
    const broken = { ...env, DOCS: { list: () => Promise.reject(new Error('R2 is down')) } };
    expect(await expirePluginExports(broken as unknown as Env)).toBe(0);
  });

  it('deletes a raw intake body at 7 days, and a failure skips nothing else', async () => {
    await env.DOCS.put('intake/shopify/2026-01-01/ret-a', '{}');
    await env.DOCS.put('intake/edi/2026-01-01/ret-b', 'ISA');
    await env.DOCS.put('orders/ret-intake/keep.html', 'kept');
    const left = async () => (await env.DOCS.list({ prefix: 'intake/' })).objects.map((o) => o.key);
    // The boundary: just inside 7 days keeps both, just past it deletes both.
    expect(await expireIntake(env, Date.now() + 7 * DAY - 60_000)).toBe(0);
    expect(await left()).toHaveLength(2);
    expect((await sweep(env, Date.now() + 7 * DAY + 60_000)).intakeBodies).toBe(2);
    expect(await left()).toEqual([]);
    // Nothing outside intake/ is touched.
    expect(await env.DOCS.head('orders/ret-intake/keep.html')).not.toBeNull();
    // A bucket that throws costs only this step: the rest of the sweep still reports.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { ...env, DOCS: { list: () => Promise.reject(new Error('R2 is down')) } };
    expect(await expireIntake(broken as unknown as Env)).toBe(0);
    expect(errors.mock.calls.some(([l]) => String(l).includes('intake_expiry_failed'))).toBe(true);
    errors.mockRestore();
    const swept = await sweep(
      {
        ...env,
        DOCS: {
          ...env.DOCS,
          list: (o: R2ListOptions) =>
            o?.prefix === 'intake/' ? Promise.reject(new Error('down')) : env.DOCS.list(o),
          delete: env.DOCS.delete.bind(env.DOCS),
          put: env.DOCS.put.bind(env.DOCS),
          get: env.DOCS.get.bind(env.DOCS),
          head: env.DOCS.head.bind(env.DOCS),
        },
      } as unknown as Env,
      Date.now(),
    );
    expect(swept.intakeBodies).toBe(0);
    expect(swept.pluginExports).toBeTypeOf('number');
  });
});
