import { DurableObject } from 'cloudflare:workers';
import { liveEventFor } from '@commerceworker/application';
import type { DomainEvent, Principal, Scope } from '@commerceworker/domain';
import type { EventBus } from '@commerceworker/ports';
import type { EdgeEnv } from '../env';
import { LIVE_ACCESS_HEADER, LIVE_STREAM_MAX_MS, liveHubName } from './live-access';

export { LIVE_ACCESS_HEADER, LIVE_STREAM_MAX_MS, liveHubName };

const HEARTBEAT_MS = 15_000;

/**
 * What a subscriber may see: the scope the live route authorized it for, and that principal's
 * content grants (absent: unrestricted).
 */
type LiveAccess = Pick<Principal, 'contentGrants'> & { readonly scope: Scope };

interface SseClient {
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly types: string[];
  readonly access: LiveAccess;
  /** When the stream ends (see LIVE_STREAM_MAX_MS). */
  readonly until: number;
}

const encoder = new TextEncoder();

function sseFrame(fields: { event: string; id?: string; data: string }): Uint8Array {
  const lines = [
    `event: ${fields.event}`,
    ...(fields.id ? [`id: ${fields.id}`] : []),
    `data: ${fields.data}`,
    '',
    '',
  ];
  return encoder.encode(lines.join('\n'));
}

const frameFor = (event: DomainEvent) =>
  sseFrame({ event: event.type, id: event.id, data: JSON.stringify(event) });

function parseAccess(header: string | null): LiveAccess | null {
  if (!header) return null;
  try {
    const parsed = JSON.parse(header) as LiveAccess;
    const scope = parsed?.scope;
    return typeof scope?.spaceId === 'string' && typeof scope.environmentId === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Live Content API fan-out hub — one object per space:environment. The queue
 * consumer publishes domain events via the `publish` RPC; delivery clients hold
 * an SSE stream served straight from `fetch` (the edge live route authorizes,
 * then forwards the request here). Dead writers are pruned on write failure.
 */
export class LiveHubDO extends DurableObject<EdgeEnv> {
  private clients = new Map<string, SseClient>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Connection counter — client keys are DO-instance-local, not entity ids. */
  private seq = 0;

  /**
   * Fan a domain event out to every connected client (filtered by ?types=), each getting only what
   * its access allows (`liveEventFor`): editorial events never, restricted keys masked or nothing.
   */
  async publish(event: DomainEvent): Promise<void> {
    // Unrestricted subscribers share one frame; a restricted one gets its own view (or none).
    let shared: Uint8Array | null | undefined;
    await this.broadcast(event.type, (client) => {
      // Defence in depth: only events of the scope this subscriber was authorized for.
      if (
        client.access.scope.spaceId !== event.scope.spaceId ||
        client.access.scope.environmentId !== event.scope.environmentId
      ) {
        return null;
      }
      if (!client.access.contentGrants) {
        if (shared === undefined) {
          const visible = liveEventFor(client.access, event);
          shared = visible ? frameFor(visible) : null;
        }
        return shared;
      }
      const visible = liveEventFor(client.access, event);
      return visible ? frameFor(visible) : null;
    });
  }

  override async fetch(req: Request): Promise<Response> {
    // Fail closed: a request the live route didn't stamp with an access policy gets nothing.
    const access = parseAccess(req.headers.get(LIVE_ACCESS_HEADER));
    if (!access) return new Response('forbidden', { status: 403 });
    const url = new URL(req.url);
    const types = (url.searchParams.get('types') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const id = String(++this.seq);
    this.clients.set(id, { writer, types, access, until: Date.now() + LIVE_STREAM_MAX_MS });
    this.ensureHeartbeat();

    // Initial ping so clients observe an open stream immediately.
    writer.write(sseFrame({ event: 'ping', data: '' })).catch(() => this.drop(id));

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  private async broadcast(
    eventType: string,
    frameOf: (client: SseClient) => Uint8Array | null,
  ): Promise<void> {
    for (const [id, client] of this.clients) {
      if (client.types.length > 0 && !client.types.includes(eventType)) continue;
      const frame = frameOf(client);
      if (!frame) continue;
      // Never await writes: a client that stopped reading would park the write
      // promise on backpressure and stall publish() (and the queue consumer
      // behind it). Zero desiredSize means the buffer is full — drop the
      // client; failed writes also drop.
      if (client.writer.desiredSize !== null && client.writer.desiredSize <= 0) {
        this.drop(id);
        continue;
      }
      client.writer.write(frame).catch(() => this.drop(id));
    }
  }

  private drop(id: string): void {
    const client = this.clients.get(id);
    this.clients.delete(id);
    client?.writer.close().catch(() => {});
    if (this.clients.size === 0 && this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private ensureHeartbeat(): void {
    // Heartbeats keep proxies from reaping idle SSE connections and detect
    // departed clients (their write fails → dropped).
    this.heartbeat ??= setInterval(() => {
      // Streams past their lifetime end here; their clients reconnect and are authorized again.
      const now = Date.now();
      for (const [id, client] of this.clients) if (client.until <= now) this.drop(id);
      const ping = sseFrame({ event: 'ping', data: '' });
      void this.broadcast('ping', () => ping);
    }, HEARTBEAT_MS);
  }
}

/**
 * EventBus over the LiveHub Durable Objects: `publish` routes an event to its
 * scope's hub. `subscribe` is unsupported here — on Cloudflare the subscribe
 * side is the DO-served SSE stream (see routes/live.ts), not this port.
 */
export function createDoEventBus(ns: DurableObjectNamespace<LiveHubDO>): EventBus {
  return {
    async publish(event) {
      const stub = ns.get(ns.idFromName(liveHubName(event.scope)));
      await stub.publish(event);
    },
    subscribe() {
      throw new Error(
        'EventBus.subscribe is not supported on Cloudflare — the live SSE route is served by LiveHubDO',
      );
    },
  };
}
