import { env } from 'cloudflare:test';
import type { DomainEvent } from '@commerceworker/domain';
import {
  createDoEventBus,
  LIVE_ACCESS_HEADER,
  liveHubName,
} from '@commerceworker/platform/do/live-hub';
import { describe, expect, it } from 'vitest';

const scope = { spaceId: 'space-1', environmentId: 'main' };

function publishedEvent(id: string): DomainEvent {
  return {
    id,
    type: 'entry.published',
    occurredAt: '2026-01-01T00:00:00.000Z',
    scope,
    entryId: `entry-${id}`,
  } as unknown as DomainEvent;
}

function unpublishedEvent(id: string): DomainEvent {
  return {
    id,
    type: 'entry.unpublished',
    occurredAt: '2026-01-01T00:00:00.000Z',
    scope,
    entryId: `entry-${id}`,
  } as unknown as DomainEvent;
}

/** Incrementally decodes an SSE byte stream into complete frames. */
function frameReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pending: string[] = [];
  return {
    async next(): Promise<string> {
      for (;;) {
        const queued = pending.shift();
        if (queued !== undefined) return queued;
        const { done, value } = await reader.read();
        if (done) throw new Error('SSE stream ended unexpectedly');
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        pending.push(...parts.filter((p) => p.length > 0));
      }
    },
    cancel: () => reader.cancel(),
  };
}

const hubStub = (name: string) => env.LIVE_HUB.get(env.LIVE_HUB.idFromName(name));

/**
 * Subscribes as the live route does: stamped with the scope it authorized and the principal's
 * grants (unrestricted by default).
 */
function subscribe(
  stub: ReturnType<typeof hubStub>,
  url: string,
  access: object = {},
): Promise<Response> {
  return stub.fetch(url, {
    headers: { [LIVE_ACCESS_HEADER]: JSON.stringify({ scope, ...access }) },
  });
}

describe('LiveHubDO', () => {
  it('opens with a ping and fans published events out to a subscriber', async () => {
    const stub = hubStub('space-1:main');
    const res = await subscribe(stub, 'https://hub/delivery/space-1/main/live');
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const frames = frameReader(res.body as ReadableStream<Uint8Array>);

    // Initial ping so clients observe an open stream immediately.
    expect(await frames.next()).toContain('event: ping');

    await stub.publish(publishedEvent('evt-1'));
    const frame = await frames.next();
    expect(frame).toContain('event: entry.published');
    expect(frame).toContain('id: evt-1');
    expect(frame).toContain('"entryId":"entry-evt-1"');
    await frames.cancel();
  });

  it('honors the ?types= filter', async () => {
    const stub = hubStub('space-1:filtered');
    const res = await subscribe(stub, 'https://hub/live?types=entry.published');
    const frames = frameReader(res.body as ReadableStream<Uint8Array>);
    expect(await frames.next()).toContain('event: ping');

    // The filtered-out event must never arrive; the next frame after it is
    // the matching one.
    await stub.publish(unpublishedEvent('evt-skip'));
    await stub.publish(publishedEvent('evt-match'));
    const frame = await frames.next();
    expect(frame).toContain('event: entry.published');
    expect(frame).toContain('id: evt-match');
    await frames.cancel();
  });

  it('delivers to every connected client of the same hub', async () => {
    const stub = hubStub('space-1:multi');
    const a = frameReader(
      (await subscribe(stub, 'https://hub/live')).body as ReadableStream<Uint8Array>,
    );
    const b = frameReader(
      (await subscribe(stub, 'https://hub/live')).body as ReadableStream<Uint8Array>,
    );
    expect(await a.next()).toContain('event: ping');
    expect(await b.next()).toContain('event: ping');

    await stub.publish(publishedEvent('evt-both'));
    expect(await a.next()).toContain('id: evt-both');
    expect(await b.next()).toContain('id: evt-both');
    await a.cancel();
    await b.cancel();
  });
});

describe('LiveHubDO access', () => {
  it('refuses a subscriber the live route did not stamp with an access policy', async () => {
    const hub = hubStub('space-1:unstamped');
    expect((await hub.fetch('https://hub/live')).status).toBe(403);
    // A stamp without a scope is refused too.
    const noScope = await hub.fetch('https://hub/live', {
      headers: { [LIVE_ACCESS_HEADER]: '{}' },
    });
    expect(noScope.status).toBe(403);
  });

  it('sends a subscriber only events of the scope it was authorized for', async () => {
    const stub = hubStub('space-1:scoped');
    const frames = frameReader(
      (await subscribe(stub, 'https://hub/live')).body as ReadableStream<Uint8Array>,
    );
    expect(await frames.next()).toContain('event: ping');
    await stub.publish({
      ...(publishedEvent('evt-other') as object),
      scope: { spaceId: 'space-1:eu', environmentId: 'main' },
    } as DomainEvent);
    await stub.publish(publishedEvent('evt-mine'));
    expect(await frames.next()).toContain('id: evt-mine');
    await frames.cancel();
  });

  it('names hubs so a separator inside an id can’t reach another scope’s hub', () => {
    expect(liveHubName({ spaceId: 'acme', environmentId: 'eu:main' })).not.toBe(
      liveHubName({ spaceId: 'acme:eu', environmentId: 'main' }),
    );
    expect(liveHubName(scope)).toBe('space-1:main');
  });

  it('never forwards editorial or internal events', async () => {
    const stub = hubStub('space-1:editorial');
    const frames = frameReader(
      (await subscribe(stub, 'https://hub/live')).body as ReadableStream<Uint8Array>,
    );
    expect(await frames.next()).toContain('event: ping');
    await stub.publish({
      id: 'evt-task',
      type: 'workflow.task_opened',
      occurredAt: '2026-01-01T00:00:00.000Z',
      scope,
      title: 'Approve the launch post',
    } as unknown as DomainEvent);
    await stub.publish(publishedEvent('evt-after'));
    // The task never arrives: the next frame is the published entry.
    const frame = await frames.next();
    expect(frame).toContain('id: evt-after');
    expect(frame).not.toContain('Approve the launch post');
    await frames.cancel();
  });

  it('shows a restricted key only the types it may read, with denied fields masked', async () => {
    const stub = hubStub('space-1:restricted');
    const restricted = frameReader(
      (
        await subscribe(stub, 'https://hub/live', {
          contentGrants: [
            { contentTypeApiId: 'post', actions: ['read'], deniedFields: ['internalNotes'] },
          ],
        })
      ).body as ReadableStream<Uint8Array>,
    );
    const open = frameReader(
      (await subscribe(stub, 'https://hub/live')).body as ReadableStream<Uint8Array>,
    );
    expect(await restricted.next()).toContain('event: ping');
    expect(await open.next()).toContain('event: ping');

    const entry = (id: string, contentTypeApiId: string) =>
      ({
        id,
        type: 'entry.published',
        occurredAt: '2026-01-01T00:00:00.000Z',
        scope,
        entryId: `entry-${id}`,
        contentTypeApiId,
        version: 1,
        fields: {
          title: { 'en-US': `A ${contentTypeApiId}` },
          internalNotes: { 'en-US': 'secret' },
        },
      }) as unknown as DomainEvent;
    await stub.publish(entry('evt-page', 'page'));
    await stub.publish(entry('evt-post', 'post'));

    // The ungranted page never reaches the restricted key; its post arrives masked.
    const post = await restricted.next();
    expect(post).toContain('id: evt-post');
    expect(post).toContain('A post');
    expect(post).not.toContain('secret');
    // An unrestricted subscriber on the same hub still sees both, unmasked.
    expect(await open.next()).toContain('id: evt-page');
    const openPost = await open.next();
    expect(openPost).toContain('id: evt-post');
    expect(openPost).toContain('secret');
    await restricted.cancel();
    await open.cancel();
  });
});

describe('createDoEventBus', () => {
  it('routes publish to the scope hub and rejects subscribe', async () => {
    const bus = createDoEventBus(env.LIVE_HUB);
    const stub = hubStub('space-1:main');
    const res = await subscribe(stub, 'https://hub/live');
    const frames = frameReader(res.body as ReadableStream<Uint8Array>);
    expect(await frames.next()).toContain('event: ping');

    // The bus resolves the hub from the event's scope — same DO name the
    // live route uses (`spaceId:environmentId`).
    await bus.publish(publishedEvent('evt-bus'));
    expect(await frames.next()).toContain('id: evt-bus');
    await frames.cancel();

    expect(() => bus.subscribe('entry.*', async () => {})).toThrow(/not supported on Cloudflare/);
  });
});
