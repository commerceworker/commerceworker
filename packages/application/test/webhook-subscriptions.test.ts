import { InMemoryWebhookOutbox } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { listWebhookDeliveries, listWebhookSubscriptions } from '../src/commerce';

const now = Date.UTC(2026, 10, 9);
const sub = (id: string, createdAt: number) => ({
  id,
  url: `https://example.com/${id}`,
  events: JSON.stringify(['order.shipped']),
  secret: 'sealed-current',
  previousSecret: 'sealed-previous',
  previousExpiresAt: null,
  createdAt,
});

describe('listWebhookSubscriptions', () => {
  it('lists newest first with the events parsed, and never a secret', async () => {
    const outbox = new InMemoryWebhookOutbox({
      subscriptions: [sub('whs_old', 1), sub('whs_new', 2)],
    });
    const list = await listWebhookSubscriptions({ outbox }, now);
    expect(list.map((s) => s.id)).toEqual(['whs_new', 'whs_old']);
    expect(list[0]?.events).toEqual(['order.shipped']);
    expect(JSON.stringify(list)).not.toMatch(/secret|sealed/i);
  });

  it('shows previousExpiresAt only while it is still ahead of now', async () => {
    const outbox = new InMemoryWebhookOutbox({
      subscriptions: [
        { ...sub('whs_open', 1), previousExpiresAt: now + 1000 },
        { ...sub('whs_ended', 2), previousExpiresAt: now - 1000 },
        { ...sub('whs_edge', 3), previousExpiresAt: now },
        sub('whs_none', 4),
      ],
    });
    const byId = Object.fromEntries(
      (await listWebhookSubscriptions({ outbox }, now)).map((s) => [s.id, s.previousExpiresAt]),
    );
    expect(byId).toEqual({
      whs_open: now + 1000,
      whs_ended: null,
      whs_edge: null,
      whs_none: null,
    });
    // Judged against the `now` it is given: a moment earlier, the ended one is still open.
    const earlier = await listWebhookSubscriptions({ outbox }, now - 2000);
    expect(earlier.find((s) => s.id === 'whs_ended')?.previousExpiresAt).toBe(now - 1000);
  });
});

describe('listWebhookDeliveries', () => {
  it('lists a subscription’s deliveries newest first with the payload parsed', async () => {
    const outbox = new InMemoryWebhookOutbox({ subscriptions: [sub('whs_a', 1)] });
    const d = (id: string, subscriptionId: string) => ({
      id,
      subscriptionId,
      subject: 'ord_1',
      event: 'order.shipped',
      payload: JSON.stringify({ orderId: 'ord_1' }),
    });
    await outbox.record([d('del_1', 'whs_a')], 10);
    await outbox.record([d('del_2', 'whs_a'), d('del_other', 'whs_b')], 20);
    const rows = await listWebhookDeliveries({ outbox }, 'whs_a');
    expect(rows.map((r) => r.id)).toEqual(['del_2', 'del_1']);
    expect(rows[0]).toMatchObject({
      orderId: 'ord_1',
      status: 'pending',
      payload: { orderId: 'ord_1' },
    });
    expect(await listWebhookDeliveries({ outbox }, 'whs_a', 1)).toHaveLength(1);
    expect(await listWebhookDeliveries({ outbox }, 'whs_none')).toEqual([]);
  });
});
