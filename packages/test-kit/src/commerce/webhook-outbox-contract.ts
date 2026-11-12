/**
 * The behaviour every `WebhookOutbox` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). Ids start `wo_`.
 */
import type { WebhookDelivery, WebhookOutbox } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { OutboxFixture } from './webhook-outbox';

const sub = (id: string, active = true) => ({
  id,
  url: `https://${id}.example/hook`,
  secret: `sealed-${id}`,
  previousSecret: null,
  previousExpiresAt: null,
  events: '["*"]',
  active,
});

export const OUTBOX_FIXTURE: OutboxFixture = {
  subscriptions: [sub('wo_on'), sub('wo_off', false)],
};

const delivery = (id: string, over: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id,
  subscriptionId: 'wo_on',
  subject: 'wo_order',
  event: 'order.completed',
  payload: '{}',
  ...over,
});

export function describeWebhookOutboxContract(
  name: string,
  make: (fixture: OutboxFixture) => Promise<WebhookOutbox>,
) {
  describe(`${name}: the webhook outbox contract`, () => {
    const ids = (xs: { id: string }[]) =>
      xs
        .map((x) => x.id)
        .filter((id) => id.startsWith('wo_'))
        .sort();

    it('lists the subscriptions that are on', async () => {
      const o = await make(OUTBOX_FIXTURE);
      expect(ids(await o.subscriptions())).toEqual(['wo_on']);
    });

    it("records each delivery once and lists what hasn't been delivered", async () => {
      const o = await make(OUTBOX_FIXTURE);
      await o.record([delivery('wo_d1'), delivery('wo_d2')], 1);
      await o.record([delivery('wo_d1', { payload: '{"again":1}' })], 2);
      await o.attempted(
        [
          { id: 'wo_d1', ok: true, status: 200, error: null },
          { id: 'wo_d2', ok: false, status: 500, error: 'HTTP 500' },
        ],
        3,
      );
      expect(ids(await o.undelivered('wo_order', ['wo_d1', 'wo_d2'], 'wo_none_'))).toEqual([
        'wo_d2',
      ]);
      const [d2] = await o.undelivered('wo_order', ['wo_d2'], 'wo_none_');
      expect(d2?.payload).toBe('{}');
    });

    it("also lists a plugin's earlier delivery for the step, though not asked for by id", async () => {
      const o = await make(OUTBOX_FIXTURE);
      await o.record(
        [
          delivery('wo_step_1_plugin_x', { subscriptionId: 'plugin:x' }),
          delivery('wo_step_1_wo_on'),
          delivery('wo_stepX_plugin_y', { subscriptionId: 'plugin:y' }),
        ],
        1,
      );
      expect(ids(await o.undelivered('wo_order', [], 'wo_step_1_'))).toEqual([
        'wo_step_1_plugin_x',
      ]);
    });

    it("lists a step's undelivered deliveries to any subscriber, and records nothing", async () => {
      const o = await make(OUTBOX_FIXTURE);
      await o.record(
        [
          delivery('wo_s_1_wo_on'),
          delivery('wo_s_1_plugin_x', { subscriptionId: 'plugin:x' }),
          delivery('wo_s_2_wo_on'),
          delivery('wo_s_1_other', { subject: 'wo_else' }),
        ],
        1,
      );
      await o.attempted([{ id: 'wo_s_1_plugin_x', ok: true, status: null, error: null }], 2);
      expect(ids(await o.unsent('wo_order', 'wo_s_1_'))).toEqual(['wo_s_1_wo_on']);
      // The prefix's wildcards are literal.
      expect(await o.unsent('wo_order', 'wo_s%')).toEqual([]);
      expect(await o.unsent('wo_gone', 'wo_s_1_')).toEqual([]);
    });

    it('finds one delivery by its id, with its attempts', async () => {
      const o = await make(OUTBOX_FIXTURE);
      await o.record([delivery('wo_one', { payload: '{"a":1}' })], 5);
      await o.attempted([{ id: 'wo_one', ok: false, status: 503, error: 'HTTP 503' }], 6);
      expect(await o.delivery('wo_one')).toEqual({
        id: 'wo_one',
        subscriptionId: 'wo_on',
        orderId: 'wo_order',
        event: 'order.completed',
        payload: '{"a":1}',
        status: 'failed',
        attempts: 1,
        responseStatus: 503,
        lastError: 'HTTP 503',
        createdAt: 5,
        deliveredAt: null,
      });
      expect(await o.delivery('wo_nope')).toBeUndefined();
    });

    it("forgets a subject's deliveries, of one event or all", async () => {
      const o = await make(OUTBOX_FIXTURE);
      await o.record(
        [
          delivery('wo_f1', { subject: 'wo_cart', event: 'cart.created' }),
          delivery('wo_f2', { subject: 'wo_cart', event: 'cart.submitted' }),
          delivery('wo_f3', { subject: 'wo_other' }),
        ],
        1,
      );
      await o.forget('wo_cart', 'cart.created');
      expect(ids(await o.undelivered('wo_cart', ['wo_f1', 'wo_f2'], 'x'))).toEqual(['wo_f2']);
      await o.forget('wo_cart');
      expect(ids(await o.undelivered('wo_cart', ['wo_f1', 'wo_f2', 'wo_f3'], 'x'))).toEqual([
        'wo_f3',
      ]);
    });

    it('lists subscriptions newest first without their secrets, adds and deletes one', async () => {
      const o = await make({ subscriptions: [{ ...sub('wo_a'), createdAt: 1 }] });
      await o.addSubscription({
        id: 'wo_b',
        url: 'https://b.example/hook',
        secret: 'sealed-b',
        events: '["order.completed"]',
        createdAt: 2,
      });
      const listed = (await o.listSubscriptions(10)).filter((x) => x.id.startsWith('wo_'));
      expect(listed).toEqual([
        {
          id: 'wo_b',
          url: 'https://b.example/hook',
          events: '["order.completed"]',
          active: true,
          createdAt: 2,
          previousExpiresAt: null,
        },
        expect.objectContaining({ id: 'wo_a', createdAt: 1 }),
      ]);
      expect((await o.subscriptions()).find((x) => x.id === 'wo_b')?.secret).toBe('sealed-b');
      expect(await o.deleteSubscription('wo_b')).toBe(true);
      expect(await o.deleteSubscription('wo_b')).toBe(false);
      expect(ids(await o.listSubscriptions(10))).toEqual(['wo_a']);
    });

    it('rotates a secret, the current one signing too until the grace ends', async () => {
      const o = await make(OUTBOX_FIXTURE);
      expect(await o.rotateSubscription('wo_on', 'sealed-next', 99)).toMatchObject({
        id: 'wo_on',
        previousExpiresAt: 99,
      });
      expect((await o.subscriptions()).find((x) => x.id === 'wo_on')).toMatchObject({
        secret: 'sealed-next',
        previousSecret: 'sealed-wo_on',
        previousExpiresAt: 99,
      });
      await o.rotateSubscription('wo_on', 'sealed-third', 199);
      expect((await o.subscriptions()).find((x) => x.id === 'wo_on')).toMatchObject({
        secret: 'sealed-third',
        previousSecret: 'sealed-next',
      });
      expect(await o.rotateSubscription('wo_none', 'x', 1)).toBeUndefined();
    });

    it("lists a subscription's deliveries newest first, with each attempt's outcome", async () => {
      const o = await make(OUTBOX_FIXTURE);
      await o.record([delivery('wo_d1')], 10);
      await o.record([delivery('wo_d2', { event: 'order.failed' })], 20);
      await o.record([delivery('wo_d3', { subscriptionId: 'wo_off' })], 30);
      await o.attempted([{ id: 'wo_d1', ok: false, status: 500, error: 'boom' }], 40);
      const list = await o.deliveries('wo_on', 10);
      expect(list.map((d) => d.id)).toEqual(['wo_d2', 'wo_d1']);
      expect(list[1]).toMatchObject({
        orderId: 'wo_order',
        event: 'order.completed',
        payload: '{}',
        status: 'failed',
        attempts: 1,
        responseStatus: 500,
        lastError: 'boom',
        createdAt: 10,
        deliveredAt: null,
      });
      expect((await o.deliveries('wo_on', 1)).map((d) => d.id)).toEqual(['wo_d2']);
    });
  });
}
