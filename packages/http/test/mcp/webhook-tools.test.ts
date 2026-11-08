import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  consumeEvent,
  createEnvironment,
  createSpace,
  deliverWebhookRequest,
  setEnvironmentAlias,
} from '@commerceworker/application';
import {
  isWebhookSendRequest,
  type Principal,
  SCOPES,
  scopesForKind,
} from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  RecordingWebhookSender,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

const SPACE = 'space-1';

function makeDeps(): McpDeps {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  return {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v: string) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
  };
}

async function connect(deps: McpDeps, principal: Principal): Promise<Client> {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function payload(result: { content?: { type: string; text?: string }[] }): unknown {
  return JSON.parse(result.content?.find((c) => c.type === 'text')?.text ?? 'null');
}

interface Summary {
  id: string;
  url: string;
  environmentId: string | null;
}

const admin: Principal = { spaceId: SPACE, kind: 'user', scopes: [SCOPES.spaceAdmin] };
const hook = { url: 'https://hooks.example.com/cw', topics: ['*'], secret: 'shh' };

describe('webhook tools over MCP', () => {
  let deps: McpDeps;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const ids = async (environment: string) =>
    (payload(await call('webhooks_list', { environment })) as { items: Summary[] }).items
      .map((h) => h.id)
      .sort();

  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'Shop', defaultLocale: 'en-US' });
    await createEnvironment(deps.ctx, SPACE, 'staging');
    client = await connect(deps, admin);
  });

  it('creates, lists, updates and deletes through the same use-cases as REST', async () => {
    const scoped = payload(
      await call('webhook_create', { ...hook, environment: 'staging' }),
    ) as Summary;
    expect(scoped.environmentId).toBe('staging');
    // The signing secret is the caller's own and is never echoed, as REST.
    expect(scoped).not.toHaveProperty('secret');
    const wide = payload(
      await call('webhook_create', { ...hook, allEnvironments: true, environment: 'staging' }),
    ) as Summary;
    expect(wide.environmentId).toBeNull();
    const mainHook = payload(await call('webhook_create', hook)) as Summary;
    expect(mainHook.environmentId).toBe('main');

    expect(await ids('staging')).toEqual([scoped.id, wide.id].sort());
    expect(await ids('main')).toEqual([mainHook.id, wide.id].sort());

    // Another environment's hook is not found from here.
    for (const [name, args] of [
      ['webhook_update', { id: scoped.id, active: false }],
      ['webhook_delete', { id: scoped.id }],
      ['webhook_deliveries', { id: scoped.id }],
    ] as const) {
      const res = await call(name, args);
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain(`Webhook \\"${scoped.id}\\" was not found`);
    }

    const kept = payload(
      await call('webhook_update', { id: scoped.id, active: false, environment: 'staging' }),
    ) as Summary & { active: boolean };
    expect(kept).toMatchObject({ active: false, environmentId: 'staging' });
    const moved = payload(
      await call('webhook_update', {
        id: scoped.id,
        allEnvironments: true,
        environment: 'staging',
      }),
    ) as Summary;
    expect(moved.environmentId).toBeNull();

    expect(
      payload(await call('webhook_deliveries', { id: scoped.id, limit: 5 })) as { items: [] },
    ).toEqual({ items: [] });
    expect(payload(await call('webhook_delete', { id: scoped.id }))).toEqual({
      deleted: scoped.id,
    });
    expect(await ids('staging')).toEqual([wide.id]);
  });

  it('never pins a hook to the target of an alias', async () => {
    await setEnvironmentAlias(deps.ctx, SPACE, 'prod', 'staging');
    const viaAlias = payload(
      await call('webhook_create', { ...hook, environment: 'prod' }),
    ) as Summary;
    expect(viaAlias.environmentId).toBeNull();
    const pinned = await call('webhook_create', {
      ...hook,
      allEnvironments: false,
      environment: 'prod',
    });
    expect(pinned.isError).toBe(true);
    // MCP carries a ValidationError's field issues, as REST's 422 body does.
    expect(payload(pinned)).toMatchObject({
      error: {
        code: 'validation_failed',
        issues: [
          expect.objectContaining({
            field: 'allEnvironments',
            message: expect.stringMatching(/is an alias/),
          }),
        ],
      },
    });

    const scoped = payload(
      await call('webhook_create', { ...hook, environment: 'staging' }),
    ) as Summary;
    const update = await call('webhook_update', {
      id: scoped.id,
      allEnvironments: false,
      environment: 'prod',
    });
    expect(update.isError).toBe(true);
    expect(JSON.stringify(update.content)).toContain('One or more fields are invalid');
    expect(
      (await deps.ctx.store.webhooks.get({ spaceId: SPACE, environmentId: 'staging' }, scoped.id))
        ?.environmentId,
    ).toBe('staging');
    // Listed under the alias as under its target: its own hooks and the space-wide ones.
    expect(await ids('prod')).toEqual([viaAlias.id, scoped.id].sort());
  });

  it('refuses a private target, as REST does', async () => {
    const res = await call('webhook_create', { ...hook, url: 'http://127.0.0.1/hook' });
    expect(res.isError).toBe(true);
    expect(await ids('main')).toEqual([]);
  });

  it('queues a test and a resend through the outbox, as REST', async () => {
    const created = payload(await call('webhook_create', hook)) as Summary;
    const test = payload(await call('webhook_test', { id: created.id })) as { eventId: string };
    const store = deps.ctx.store as InMemoryContentStore;
    let consumed = 0;
    const engine = async () => {
      const sender = new RecordingWebhookSender();
      const events = store.allOutbox().slice(consumed);
      consumed += events.length;
      for (const e of events) {
        if (isWebhookSendRequest(e)) await deliverWebhookRequest(deps.ctx, { sender }, e);
        else await consumeEvent(deps.ctx, { sender }, e);
      }
      return sender;
    };
    expect((await engine()).sent.map((s) => s.event.type)).toEqual(['webhook.test']);
    const { items } = payload(await call('webhook_deliveries', { id: created.id })) as {
      items: { id: number; eventId: string; eventType: string }[];
    };
    expect(items).toMatchObject([{ eventId: test.eventId, eventType: 'webhook.test' }]);
    const original = items[0]?.id;

    const resend = payload(
      await call('webhook_resend', { id: created.id, deliveryId: original }),
    ) as { resendOf: number };
    expect(resend).toMatchObject({ eventId: test.eventId, resendOf: original });
    expect((await engine()).sent.map((s) => s.event.id)).toEqual([test.eventId]);

    const missing = await call('webhook_resend', { id: created.id, deliveryId: 999 });
    expect(missing.isError).toBe(true);
    // Another environment's view of a main-scoped hook: not found, as REST's 404.
    const elsewhere = await call('webhook_test', { id: created.id, environment: 'staging' });
    expect(elsewhere.isError).toBe(true);
    expect(JSON.stringify(elsewhere.content)).toContain(
      `Webhook \\"${created.id}\\" was not found`,
    );
  });

  it('refuses a key without space:admin, and one for another space', async () => {
    const editor = await connect(deps, {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [...scopesForKind('cma')].filter((s) => s !== SCOPES.spaceAdmin),
    });
    expect((await editor.callTool({ name: 'webhooks_list', arguments: {} })).isError).toBe(true);
    expect((await editor.callTool({ name: 'webhook_create', arguments: hook })).isError).toBe(true);
    const mine = payload(await call('webhook_create', hook)) as Summary;
    for (const [name, args] of [
      ['webhook_test', { id: mine.id }],
      ['webhook_resend', { id: mine.id, deliveryId: 1 }],
    ] as const) {
      expect((await editor.callTool({ name, arguments: args })).isError).toBe(true);
    }
    expect((deps.ctx.store as InMemoryContentStore).allOutbox()).toEqual([]);
    await call('webhook_delete', { id: mine.id });
    const other = await connect(deps, {
      spaceId: 'space-2',
      kind: 'user',
      scopes: [SCOPES.spaceAdmin],
    });
    expect(
      (await other.callTool({ name: 'webhook_create', arguments: { ...hook, space: SPACE } }))
        .isError,
    ).toBe(true);
    expect(await ids('main')).toEqual([]);
  });
});
