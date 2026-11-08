import { isWebhookSendRequest, type WebhookSendRequest } from '@commerceworker/domain';
import { isAgentJob, isDomainEvent } from '@commerceworker/platform/messages';
import { describe, expect, it } from 'vitest';

const scope = { spaceId: 'space-1', environmentId: 'main' };

describe('isDomainEvent', () => {
  it('accepts a well-formed queued event', () => {
    expect(
      isDomainEvent({
        id: 'evt-1',
        type: 'entry.published',
        occurredAt: '2026-01-01T00:00:00.000Z',
        scope,
        entryId: 'entry-1',
      }),
    ).toBe(true);
  });

  it('rejects non-objects and null', () => {
    expect(isDomainEvent(null)).toBe(false);
    expect(isDomainEvent('entry.published')).toBe(false);
    expect(isDomainEvent(42)).toBe(false);
  });

  it('rejects events missing required fields or scope parts', () => {
    const base = {
      id: 'evt-1',
      type: 'entry.published',
      occurredAt: '2026-01-01T00:00:00.000Z',
      scope,
    };
    expect(isDomainEvent({ ...base, id: undefined })).toBe(false);
    expect(isDomainEvent({ ...base, occurredAt: 12345 })).toBe(false);
    expect(isDomainEvent({ ...base, scope: undefined })).toBe(false);
    expect(isDomainEvent({ ...base, scope: { spaceId: 'space-1' } })).toBe(false);
  });
});

describe('isAgentJob', () => {
  it('accepts a well-formed agent job', () => {
    expect(isAgentJob({ kind: 'agent.publish_run', scope, entryId: 'entry-1' })).toBe(true);
  });

  it('rejects other kinds and malformed jobs', () => {
    expect(isAgentJob(null)).toBe(false);
    expect(isAgentJob({ kind: 'agent.other_run', scope, entryId: 'entry-1' })).toBe(false);
    expect(isAgentJob({ kind: 'agent.publish_run', scope })).toBe(false);
    expect(isAgentJob({ kind: 'agent.publish_run', entryId: 'entry-1' })).toBe(false);
    // A DomainEvent is not an agent job — the commerceworker-agents consumer must not
    // accept messages meant for commerceworker-events.
    expect(
      isAgentJob({
        id: 'evt-1',
        type: 'entry.published',
        occurredAt: '2026-01-01T00:00:00.000Z',
        scope,
      }),
    ).toBe(false);
  });
});

describe('webhook send requests on the events queue', () => {
  // What `sendWebhookTest` and `resendWebhookDelivery` append to the outbox, as the relay sends it.
  const test: WebhookSendRequest = {
    kind: 'webhook.send',
    id: 'evt-test',
    scope,
    occurredAt: '2026-01-01T00:00:00.000Z',
    webhookId: 'wh-1',
    test: {
      id: 'evt-test',
      type: 'webhook.test',
      scope,
      occurredAt: '2026-01-01T00:00:00.000Z',
      webhookId: 'wh-1',
      message: 'test',
    },
  };
  const resend: WebhookSendRequest = {
    kind: 'webhook.send',
    id: 'req-1',
    scope,
    occurredAt: '2026-01-01T00:00:00.000Z',
    webhookId: 'wh-1',
    resend: { deliveryId: 7, eventId: 'evt-1' },
  };

  it('is no domain event, so an engine without the send-request branch drops it unsent', () => {
    // `isDomainEvent` is the gate every engine's events consumer applies before dispatch (and is
    // unchanged by the change that added send requests): a rolled-back engine acks these as
    // malformed instead of fanning them out to every "*" webhook.
    for (const request of [test, resend]) {
      const queued = JSON.parse(JSON.stringify(request)) as unknown;
      expect(isDomainEvent(queued)).toBe(false);
      expect(isWebhookSendRequest(queued)).toBe(true);
    }
  });

  it('is not mistaken for one by a domain event, however it is shaped', () => {
    expect(isWebhookSendRequest(test.test)).toBe(false);
    expect(isWebhookSendRequest({ ...resend, resend: undefined })).toBe(false);
    expect(isWebhookSendRequest({ ...resend, kind: 'webhook.retry' })).toBe(false);
  });
});
