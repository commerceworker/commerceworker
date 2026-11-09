import {
  consumeEvent,
  createEnvironment,
  deliverWebhookRequest,
  setEnvironmentAlias,
} from '@commerceworker/application';
import { isWebhookSendRequest } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { type InMemoryContentStore, RecordingWebhookSender } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const env = (name: string) => `/spaces/s1/environments/${name}/webhooks`;
const hook = { url: 'https://hooks.example.com/cw', topics: ['*'], secret: 'shh' };

interface Summary {
  id: string;
  environmentId: string | null;
}

describe('webhooks under an environment', () => {
  let app: ReturnType<typeof createApp>;
  const create = async (name: string, body: object) => {
    const res = await app.request(env(name), {
      method: 'POST',
      headers: cma,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Summary;
  };
  const list = async (name: string) =>
    ((await (await app.request(env(name), { headers: cma })).json()) as { items: Summary[] }).items
      .map((h) => h.id)
      .sort();

  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
    await createEnvironment(ctx, 's1', 'staging');
    await setEnvironmentAlias(ctx, 's1', 'prod', 'staging');
  });

  it('scopes a hook to the path environment, or to every one with allEnvironments', async () => {
    const scoped = await create('staging', hook);
    expect(scoped.environmentId).toBe('staging');
    expect(scoped).not.toHaveProperty('secret');
    const wide = await create('staging', { ...hook, allEnvironments: true });
    expect(wide.environmentId).toBeNull();
    const mainHook = await create('main', hook);

    expect(await list('staging')).toEqual([scoped.id, wide.id].sort());
    expect(await list('main')).toEqual([mainHook.id, wide.id].sort());
  });

  it("answers 404 for another environment's hook, and moves one with allEnvironments", async () => {
    const scoped = await create('staging', hook);
    const put = (name: string, body: object) =>
      app.request(`${env(name)}/${scoped.id}`, {
        method: 'PUT',
        headers: cma,
        body: JSON.stringify(body),
      });
    expect((await put('main', { active: false })).status).toBe(404);
    expect(
      (await app.request(`${env('main')}/${scoped.id}`, { method: 'DELETE', headers: cma })).status,
    ).toBe(404);
    expect(
      (await app.request(`${env('main')}/${scoped.id}/deliveries`, { headers: cma })).status,
    ).toBe(404);

    // Omitted, the scope stays; true makes it space-wide; false scopes it to the path's environment.
    expect(
      ((await (await put('staging', { active: false })).json()) as Summary).environmentId,
    ).toBe('staging');
    expect(
      ((await (await put('staging', { allEnvironments: true })).json()) as Summary).environmentId,
    ).toBeNull();
    expect(
      ((await (await put('main', { allEnvironments: false })).json()) as Summary).environmentId,
    ).toBe('main');
    expect(await list('staging')).toEqual([]);
  });

  it('makes a hook created through an alias space-wide, and refuses to pin one to it', async () => {
    const viaAlias = await create('prod', hook);
    expect(viaAlias.environmentId).toBeNull();
    const pinned = await app.request(env('prod'), {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ ...hook, allEnvironments: false }),
    });
    expect(pinned.status).toBe(422);
    expect(JSON.stringify(await pinned.json())).toContain('is an alias');

    const scoped = await create('staging', hook);
    const repin = await app.request(`${env('prod')}/${scoped.id}`, {
      method: 'PUT',
      headers: cma,
      body: JSON.stringify({ allEnvironments: false }),
    });
    expect(repin.status).toBe(422);
    // Omitted under the alias, the scope stays.
    const kept = await app.request(`${env('prod')}/${scoped.id}`, {
      method: 'PUT',
      headers: cma,
      body: JSON.stringify({ active: false }),
    });
    expect(((await kept.json()) as Summary).environmentId).toBe('staging');
  });

  it('refuses a non-boolean allEnvironments, and a private target', async () => {
    const bad = await app.request(env('main'), {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ ...hook, allEnvironments: 'yes' }),
    });
    expect(bad.status).toBe(422);
    const internal = await app.request(env('main'), {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ ...hook, url: 'http://10.0.0.1/hook' }),
    });
    expect(internal.status).toBe(422);
  });
});

describe('webhook tests and resends', () => {
  let app: ReturnType<typeof createApp>;
  let ctx: ReturnType<typeof wire>['ctx'];
  const post = (path: string, headers: Record<string, string> = cma) =>
    app.request(path, { method: 'POST', headers });
  /** The engine: consumes every outbox event this test has not consumed yet. */
  let consumed = 0;
  const engine = async (sender = new RecordingWebhookSender()) => {
    const store = ctx.store as InMemoryContentStore;
    const events = store.allOutbox().slice(consumed);
    consumed += events.length;
    for (const e of events) {
      if (isWebhookSendRequest(e)) await deliverWebhookRequest(ctx, { sender }, e);
      else await consumeEvent(ctx, { sender }, e);
    }
    return sender;
  };
  const deliveries = async (id: string) =>
    (
      (await (await app.request(`${env('main')}/${id}/deliveries`, { headers: cma })).json()) as {
        items: { id: number; eventId: string; eventType?: string; resendOf?: number }[];
      }
    ).items;

  beforeEach(async () => {
    const wired = wire(config);
    ctx = wired.ctx;
    app = createApp(ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
    consumed = (ctx.store as InMemoryContentStore).allOutbox().length;
  });

  it('queues a test (202), which the engine sends and logs as webhook.test', async () => {
    const created = (await (
      await app.request(env('main'), { method: 'POST', headers: cma, body: JSON.stringify(hook) })
    ).json()) as Summary;
    const res = await post(`${env('main')}/${created.id}/test`);
    expect(res.status).toBe(202);
    const queued = (await res.json()) as { eventId: string; eventType: string };
    expect(queued.eventType).toBe('webhook.test');
    const sender = await engine();
    expect(sender.sent.map((s) => s.event.id)).toEqual([queued.eventId]);
    expect(await deliveries(created.id)).toMatchObject([
      { eventId: queued.eventId, eventType: 'webhook.test' },
    ]);
  });

  it('resends a delivery (202), linked to the original, and 404s or 409s as it should', async () => {
    const created = (await (
      await app.request(env('main'), { method: 'POST', headers: cma, body: JSON.stringify(hook) })
    ).json()) as Summary;
    await post(`${env('main')}/${created.id}/test`);
    await engine();
    const [original] = await deliveries(created.id);
    if (!original) throw new Error('no delivery');

    const res = await post(`${env('main')}/${created.id}/deliveries/${original.id}/resend`);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ eventId: original.eventId, resendOf: original.id });
    const sender = await engine();
    expect(sender.sent.map((s) => s.event.id)).toEqual([original.eventId]);
    expect((await deliveries(created.id))[0]).toMatchObject({ resendOf: original.id });

    for (const bad of ['999999', 'abc', '0', '1.5']) {
      expect((await post(`${env('main')}/${created.id}/deliveries/${bad}/resend`)).status).toBe(
        404,
      );
    }
    // Another environment's view of an environment-scoped hook: not found.
    expect((await post(`${env('staging')}/${created.id}/test`)).status).toBe(404);

    // The event swept by retention while its delivery record remains: 409.
    const store = ctx.store as InMemoryContentStore;
    await store.outbox.markRelayed(store.allOutbox().map((e) => e.id));
    await store.outbox.deleteRelayedBefore(new Date(Date.now() + 60_000), 1000);
    expect(
      (await post(`${env('main')}/${created.id}/deliveries/${original.id}/resend`)).status,
    ).toBe(409);
  });

  it('needs space:admin, as managing webhooks does', async () => {
    const created = (await (
      await app.request(env('main'), { method: 'POST', headers: cma, body: JSON.stringify(hook) })
    ).json()) as Summary;
    const cda = { Authorization: 'Bearer cda' };
    expect((await post(`${env('main')}/${created.id}/test`, cda)).status).toBe(403);
    expect((await post(`${env('main')}/${created.id}/deliveries/1/resend`, cda)).status).toBe(403);
    expect((ctx.store as InMemoryContentStore).allOutbox().filter(isWebhookSendRequest)).toEqual(
      [],
    );
  });
});
