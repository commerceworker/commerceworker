/**
 * The outbound webhooks port in memory, seeded with subscriptions. The contract in
 * ./webhook-outbox-contract.ts holds it to the same behaviour as the D1 store.
 */
import type {
  DeliveryRecord,
  SubscriptionView,
  WebhookDelivery,
  WebhookOutbox,
  WebhookSubscription,
} from '@commerceworker/ports/commerce';

type Row = WebhookDelivery & {
  status: string;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  deliveredAt: number | null;
  createdAt: number;
};

type Subscription = WebhookSubscription & { active: boolean; createdAt: number };

export interface OutboxFixture {
  subscriptions?: (WebhookSubscription & { active?: boolean; createdAt?: number })[];
}

export class InMemoryWebhookOutbox implements WebhookOutbox {
  readonly rows = new Map<string, Row>();

  private readonly subs: Subscription[];

  constructor(fixture: OutboxFixture = {}) {
    this.subs = structuredClone(fixture.subscriptions ?? []).map((s) => ({
      ...s,
      active: s.active ?? true,
      createdAt: s.createdAt ?? 0,
    }));
  }

  async subscriptions() {
    return this.subs
      .filter((s) => s.active)
      .map(({ active: _a, createdAt: _c, ...s }) => ({ ...s }));
  }

  private view(s: Subscription): SubscriptionView {
    return {
      id: s.id,
      url: s.url,
      events: s.events,
      active: s.active,
      createdAt: s.createdAt,
      previousExpiresAt: s.previousExpiresAt,
    };
  }

  async listSubscriptions(limit: number) {
    return [...this.subs]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((s) => this.view(s));
  }

  async addSubscription(s: {
    id: string;
    url: string;
    secret: string;
    events: string;
    createdAt: number;
  }) {
    if (this.subs.some((x) => x.id === s.id)) throw new Error('UNIQUE constraint failed');
    this.subs.push({ ...s, previousSecret: null, previousExpiresAt: null, active: true });
  }

  async rotateSubscription(id: string, secret: string, previousUntil: number) {
    const i = this.subs.findIndex((s) => s.id === id);
    const s = this.subs[i];
    if (!s) return undefined;
    const next = { ...s, previousSecret: s.secret, secret, previousExpiresAt: previousUntil };
    this.subs[i] = next;
    return this.view(next);
  }

  async deleteSubscription(id: string) {
    const i = this.subs.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.subs.splice(i, 1);
    return true;
  }

  async deliveries(subscriptionId: string, limit: number): Promise<DeliveryRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.subscriptionId === subscriptionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(({ subject, ...r }) => ({ ...r, orderId: subject }));
  }

  async record(deliveries: readonly WebhookDelivery[], now: number) {
    for (const x of deliveries)
      if (!this.rows.has(x.id))
        this.rows.set(x.id, {
          ...x,
          status: 'pending',
          attempts: 0,
          responseStatus: null,
          lastError: null,
          deliveredAt: null,
          createdAt: now,
        });
  }

  async undelivered(subject: string, ids: readonly string[], idPrefix: string) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.status !== 'delivered' &&
          (ids.includes(r.id) ||
            (r.subject === subject &&
              r.id.startsWith(idPrefix) &&
              r.subscriptionId.startsWith('plugin:'))),
      )
      .map(({ id, subscriptionId, subject: s, event, payload }) => ({
        id,
        subscriptionId,
        subject: s,
        event,
        payload,
      }));
  }

  async delivery(id: string): Promise<DeliveryRecord | undefined> {
    const row = this.rows.get(id);
    if (!row) return undefined;
    const { subject, ...rest } = row;
    return { ...rest, orderId: subject };
  }

  async unsent(subject: string, idPrefix: string) {
    return [...this.rows.values()]
      .filter((r) => r.status !== 'delivered' && r.subject === subject && r.id.startsWith(idPrefix))
      .map(({ id, subscriptionId, subject: s, event, payload }) => ({
        id,
        subscriptionId,
        subject: s,
        event,
        payload,
      }));
  }

  async attempted(
    results: readonly { id: string; ok: boolean; status: number | null; error: string | null }[],
    now: number,
  ) {
    for (const r of results) {
      const row = this.rows.get(r.id);
      if (row)
        Object.assign(row, {
          status: r.ok ? 'delivered' : 'failed',
          attempts: row.attempts + 1,
          responseStatus: r.status,
          lastError: r.error,
          deliveredAt: r.ok ? now : null,
        });
    }
  }

  async forget(subject: string, event?: string) {
    for (const [id, r] of this.rows)
      if (r.subject === subject && (!event || r.event === event)) this.rows.delete(id);
  }
}
