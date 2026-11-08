import type { DomainEvent, EntriesPublishedBulkEvent, Webhook } from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createSpace,
  createWebhook,
  deleteWebhook,
  dispatchEvent,
  listWebhookDeliveries,
  redeliverWebhook,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookRetry,
  webhookRetryDelay,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };
const event = {
  id: 'evt-1',
  type: 'entry.unpublished',
  scope,
  occurredAt: '2026-01-01T00:00:00.000Z',
  entryId: 'e1',
  contentTypeApiId: 'article',
} as DomainEvent;

let ctx: AppContext;
let webhookId: string;

beforeEach(async () => {
  ctx = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('w'),
  };
  await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  webhookId = (
    await createWebhook(ctx, scope, {
      url: 'https://hooks.example.com/cw',
      topics: ['entry.unpublished'],
      secret: 's3cret',
    })
  ).id;
});

function deps(delivered: boolean) {
  const scheduled: WebhookRetry[] = [];
  return {
    sender: new RecordingWebhookSender(
      delivered ? { delivered: true, statusCode: 200 } : { delivered: false, statusCode: 503 },
    ),
    scheduleWebhookRetry: async (r: WebhookRetry) => {
      scheduled.push(r);
    },
    scheduled,
  };
}

describe('webhook delivery retries', () => {
  it('schedules a retry of the failed webhook alone, after the backoff', async () => {
    const d = deps(false);
    await dispatchEvent(ctx, d, event);
    expect(d.scheduled).toEqual([{ webhookId, event, attempt: 2, delaySeconds: 30 }]);
    const [logged] = await listWebhookDeliveries(ctx, scope, webhookId);
    expect(logged).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('records a retry by its attempt number, and stops scheduling once it is delivered', async () => {
    const d = deps(true);
    expect(await redeliverWebhook(ctx, d, { webhookId, event, attempt: 3 })).toEqual({
      delivered: true,
    });
    expect(d.scheduled).toEqual([]);
    const [logged] = await listWebhookDeliveries(ctx, scope, webhookId);
    expect(logged).toMatchObject({ status: 'success', attempts: 3 });
  });

  it('backs off longer each time, and gives up after the last attempt', async () => {
    expect([1, 2, 3, 4].map(webhookRetryDelay)).toEqual([30, 120, 480, 1920]);
    expect(webhookRetryDelay(20)).toBe(6 * 3600);
    const d = deps(false);
    await redeliverWebhook(ctx, d, { webhookId, event, attempt: WEBHOOK_MAX_ATTEMPTS - 1 });
    expect(d.scheduled.map((r) => r.attempt)).toEqual([WEBHOOK_MAX_ATTEMPTS]);
    await redeliverWebhook(ctx, d, { webhookId, event, attempt: WEBHOOK_MAX_ATTEMPTS });
    expect(d.scheduled).toHaveLength(1);
  });

  it('sends nothing to a webhook deleted since the delivery failed', async () => {
    await deleteWebhook(ctx, scope, webhookId);
    const d = deps(true);
    expect(await redeliverWebhook(ctx, d, { webhookId, event, attempt: 2 })).toBeNull();
    expect(d.sender.sent).toEqual([]);
  });
});

/** A receiver that is down for some entries: sends to those fail, the rest arrive. */
class FlakyReceiver {
  readonly sent: { webhook: Webhook; event: DomainEvent }[] = [];
  constructor(readonly down: Set<string>) {}
  async send(webhook: Webhook, event: DomainEvent) {
    this.sent.push({ webhook, event });
    const entryId = (event as { entryId?: string }).entryId;
    return entryId && this.down.has(entryId)
      ? { delivered: false, statusCode: 503 }
      : { delivered: true, statusCode: 200 };
  }
}

const bulk: EntriesPublishedBulkEvent = {
  id: 'evt-bulk-1',
  type: 'entries.published_bulk',
  scope,
  occurredAt: '2026-01-01T00:00:00.000Z',
  jobId: 'job-1',
  chunkId: 'chunk-3',
  action: 'unpublish',
  entryIds: ['e1', 'e2', 'e3', 'e4', 'e5'],
};

describe('webhook delivery retries for a bulk chunk', () => {
  function flaky(down: string[]) {
    const scheduled: WebhookRetry[] = [];
    return {
      sender: new FlakyReceiver(new Set(down)),
      scheduleWebhookRetry: async (r: WebhookRetry) => {
        scheduled.push(r);
      },
      scheduled,
    };
  }

  it('retries a per-entry subscriber with only the entries that failed', async () => {
    const d = flaky(['e2', 'e4']);
    await dispatchEvent(ctx, d, bulk);
    expect(d.sender.sent).toHaveLength(5);
    expect(d.scheduled).toEqual([
      { webhookId, event: { ...bulk, entryIds: ['e2', 'e4'] }, attempt: 2, delaySeconds: 30 },
    ]);
    const [logged] = await listWebhookDeliveries(ctx, scope, webhookId);
    expect(logged).toMatchObject({ status: 'failed', attempts: 1 });
    expect(logged?.error).toMatch(/^2\/5 deliveries failed/);
  });

  it('resends the failed entries one by one, with the ids the receiver already dedupes on', async () => {
    const d = flaky([]);
    const retry = { webhookId, event: { ...bulk, entryIds: ['e2', 'e4'] }, attempt: 2 };
    expect(await redeliverWebhook(ctx, d, retry)).toEqual({ delivered: true });
    expect(d.sender.sent.map((s) => [s.event.type, s.event.id])).toEqual([
      ['entry.unpublished', 'job-1:chunk-3:e2'],
      ['entry.unpublished', 'job-1:chunk-3:e4'],
    ]);
    expect(d.scheduled).toEqual([]);
    const [logged] = await listWebhookDeliveries(ctx, scope, webhookId);
    expect(logged).toMatchObject({ status: 'success', attempts: 2 });
  });

  it('narrows each retry to what still fails, and gives up after the last attempt', async () => {
    const d = flaky(['e4']);
    const retry = { webhookId, event: { ...bulk, entryIds: ['e2', 'e4'] }, attempt: 2 };
    expect(await redeliverWebhook(ctx, d, retry)).toEqual({ delivered: false });
    expect(d.scheduled).toEqual([
      { webhookId, event: { ...bulk, entryIds: ['e4'] }, attempt: 3, delaySeconds: 120 },
    ]);
    await redeliverWebhook(ctx, d, {
      webhookId,
      event: { ...bulk, entryIds: ['e4'] },
      attempt: WEBHOOK_MAX_ATTEMPTS,
    });
    expect(d.scheduled).toHaveLength(1);
  });

  it('retries a bulk-topic subscriber with the bulk event', async () => {
    const bulkHook = (
      await createWebhook(ctx, scope, {
        url: 'https://hooks.example.com/bulk',
        topics: ['entries.published_bulk'],
        secret: 's3cret',
      })
    ).id;
    const scheduled: WebhookRetry[] = [];
    const d = {
      sender: new RecordingWebhookSender({ delivered: false, statusCode: 503 }),
      scheduleWebhookRetry: async (r: WebhookRetry) => {
        scheduled.push(r);
      },
    };
    await dispatchEvent(ctx, d, bulk);
    expect(scheduled.find((r) => r.webhookId === bulkHook)).toEqual({
      webhookId: bulkHook,
      event: bulk,
      attempt: 2,
      delaySeconds: 30,
    });
    const ok = {
      sender: new RecordingWebhookSender(),
      scheduleWebhookRetry: d.scheduleWebhookRetry,
    };
    expect(
      await redeliverWebhook(ctx, ok, { webhookId: bulkHook, event: bulk, attempt: 2 }),
    ).toEqual({ delivered: true });
    expect(ok.sender.sent.map((s) => s.event.id)).toEqual(['evt-bulk-1']);
  });

  it('sends nothing to a per-entry subscriber deleted since the chunk failed', async () => {
    await deleteWebhook(ctx, scope, webhookId);
    const d = flaky([]);
    const retry = { webhookId, event: { ...bulk, entryIds: ['e2'] }, attempt: 2 };
    expect(await redeliverWebhook(ctx, d, retry)).toBeNull();
    expect(d.sender.sent).toEqual([]);
  });
});
