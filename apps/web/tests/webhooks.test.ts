import { ROTATION_GRACE_MS, secretContext } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));
/** Sealing, as a marker the test can read back. */
vi.mock('~/lib/data-key.server', () => ({
  sealSecret: async (secret: string, context: string) => `sealed(${context}):${secret}`,
}));

const { InMemoryPluginInstallStore, InMemoryWebhookOutbox } = await import(
  '@commerceworker/test-kit/commerce'
);
let outbox = new InMemoryWebhookOutbox();
let plugins = new InMemoryPluginInstallStore();
vi.mock('~/lib/wire.server', () => ({
  webhookOutbox: () => outbox,
  pluginInstalls: () => plugins,
}));

const {
  createSubscription,
  deleteSubscription,
  listDeliveries,
  listPluginErrors,
  listSubscriptions,
  rotateSubscription,
} = await import('~/lib/webhooks.server');

beforeEach(() => {
  outbox = new InMemoryWebhookOutbox();
  plugins = new InMemoryPluginInstallStore();
});

describe('webhook subscriptions', () => {
  it('hands the secret over once, stores it sealed for its row, and never lists it', async () => {
    const { subscription, secret } = await createSubscription({
      url: 'https://erp.example/hook',
      events: ['order.completed'],
    });
    expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(subscription).toMatchObject({ events: ['order.completed'], previousExpiresAt: null });
    expect(subscription).not.toHaveProperty('secret');
    const [stored] = await outbox.subscriptions();
    expect(stored?.secret).toBe(
      `sealed(${secretContext.webhookSubscription(subscription.id)}):${secret}`,
    );
    const [listed] = await listSubscriptions();
    expect(listed).toEqual(subscription);
    expect(JSON.stringify(await listSubscriptions())).not.toContain(secret);
  });

  it('rotates with a grace window shown only while it lasts, and not for an unknown id', async () => {
    const { subscription, secret: first } = await createSubscription({
      url: 'https://erp.example/hook',
      events: ['*'],
    });
    const before = Date.now();
    const rotated = await rotateSubscription(subscription.id);
    expect(rotated?.secret).not.toBe(first);
    expect(rotated?.subscription.previousExpiresAt).toBeGreaterThanOrEqual(
      before + ROTATION_GRACE_MS,
    );
    expect((await outbox.subscriptions())[0]?.previousSecret).toContain(first);
    // Once the grace is over, the list no longer mentions it.
    await outbox.rotateSubscription(subscription.id, 'sealed-x', Date.now() - 1);
    expect((await listSubscriptions())[0]?.previousExpiresAt).toBeNull();
    expect(await rotateSubscription('whs_none')).toBeNull();
    expect(await deleteSubscription(subscription.id)).toBe(true);
    expect(await deleteSubscription(subscription.id)).toBe(false);
  });

  it("reads a subscription's deliveries with their payloads parsed", async () => {
    await outbox.record(
      [
        {
          id: 'd1',
          subscriptionId: 'whs_1',
          subject: 'ord_1',
          event: 'order.completed',
          payload: '{"total":12}',
        },
      ],
      5,
    );
    expect(await listDeliveries('whs_1')).toEqual([
      expect.objectContaining({ id: 'd1', orderId: 'ord_1', payload: { total: 12 } }),
    ]);
  });

  it("reads a plugin's latest errors, newest first, naming the plugin", async () => {
    await plugins.recordErrors(
      'acme',
      [
        { message: 'old', at: 1 },
        { message: 'new', at: 2 },
      ],
      10,
    );
    expect((await listPluginErrors('acme', 1)).map((e) => [e.pluginId, e.message])).toEqual([
      ['acme', 'new'],
    ]);
  });
});
