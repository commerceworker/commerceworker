import { createHmac } from 'node:crypto';
import type { DomainEvent, Webhook } from '@commerceworker/domain';
import { describe, expect, it } from 'vitest';
import { createHttpFunctionInvoker } from '../../src/http-effects/function-invoker';
import { createWebhookSender } from '../../src/http-effects/webhook-sender';

const scope = { spaceId: 'space-1', environmentId: 'env-1' };

const event: DomainEvent = {
  id: 'ev-1',
  type: 'entry.published',
  scope,
  entryId: 'entry-1',
  occurredAt: '2026-01-01T00:00:00.000Z',
} as DomainEvent;

const webhook: Webhook = {
  id: 'wh-1',
  url: 'https://example.test/hook',
  topics: ['entry.published'],
  secret: 'shh',
  headers: { 'x-custom': 'yes' },
  active: true,
  environmentId: scope.environmentId,
};

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { impl, calls };
}

describe('createWebhookSender', () => {
  it('posts the event with a verifiable HMAC signature and custom headers', async () => {
    const { impl, calls } = fakeFetch(() => new Response('ok', { status: 200 }));
    const result = await createWebhookSender(impl).send(webhook, event);

    expect(result).toEqual({ delivered: true, statusCode: 200 });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(webhook.url);
    const headers = call?.init.headers as Record<string, string>;
    const body = call?.init.body as string;
    const expected = createHmac('sha256', webhook.secret)
      .update(`${event.occurredAt}.${body}`)
      .digest('hex');
    expect(headers['x-commerceworker-signature']).toBe(`sha256=${expected}`);
    expect(headers['x-commerceworker-timestamp']).toBe(event.occurredAt);
    expect(headers['x-commerceworker-event']).toBe('entry.published');
    expect(headers['x-commerceworker-event-id']).toBe(event.id);
    expect(headers).not.toHaveProperty('x-commerceworker-resend-of');
    expect(headers['x-custom']).toBe('yes');
    expect(JSON.parse(body)).toEqual(event);
  });

  it('signs a resend at the given timestamp and names the delivery it repeats', async () => {
    const { impl, calls } = fakeFetch(() => new Response('ok', { status: 200 }));
    const at = '2026-03-01T12:00:00.000Z';
    await createWebhookSender(impl).send(webhook, event, { timestamp: at, resendOf: 7 });
    const headers = calls[0]?.init.headers as Record<string, string>;
    const body = calls[0]?.init.body as string;
    const expected = createHmac('sha256', webhook.secret).update(`${at}.${body}`).digest('hex');
    expect(headers['x-commerceworker-timestamp']).toBe(at);
    expect(headers['x-commerceworker-event-id']).toBe(event.id);
    expect(headers['x-commerceworker-resend-of']).toBe('7');
    expect(headers['x-commerceworker-signature']).toBe(`sha256=${expected}`);
    expect(JSON.parse(body)).toEqual(event);
  });

  it('reports non-2xx as undelivered with the status code', async () => {
    const { impl } = fakeFetch(() => new Response('nope', { status: 500 }));
    const result = await createWebhookSender(impl).send(webhook, event);
    expect(result).toEqual({ delivered: false, statusCode: 500 });
  });

  it('reports network errors as undelivered with the message', async () => {
    const { impl } = fakeFetch(() => {
      throw new Error('boom');
    });
    const result = await createWebhookSender(impl).send(webhook, event);
    expect(result).toEqual({ delivered: false, error: 'boom' });
  });
});

describe('createHttpFunctionInvoker', () => {
  it('posts the event and reports ok with status', async () => {
    const { impl, calls } = fakeFetch(() => new Response('ok', { status: 202 }));
    const result = await createHttpFunctionInvoker(impl).invoke('https://fn.test/run', event);
    expect(result).toEqual({ ok: true, statusCode: 202 });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-commerceworker-event']).toBe('entry.published');
  });

  it('reports network errors as ok: false', async () => {
    const { impl } = fakeFetch(() => {
      throw new Error('down');
    });
    const result = await createHttpFunctionInvoker(impl).invoke('https://fn.test/run', event);
    expect(result).toEqual({ ok: false, error: 'down' });
  });
});
