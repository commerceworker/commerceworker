import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { type AppContext, createSpace, dispatchEvent } from '@commerceworker/application';
import { type DomainEvent, type Principal, scopesForKind } from '@commerceworker/domain';
import { starterChunkRunner } from '@commerceworker/seed';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  RecordingWebhookSender,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

/**
 * The MCP side of the enterprise starter: space_create with it (where offered), space_starters_list
 * as GET /starters, and starter_install_get as GET …/starter-installs/{install}. Stand-in phases.
 */
vi.mock('../../../seed/src/enterprise/phases', async () => {
  const { createTag } = await import('@commerceworker/application');
  const phase = (id: string) => ({
    id,
    title: `Phase ${id}`,
    run: async (run: { ctx: AppContext; scope: { spaceId: string; environmentId: string } }) => {
      await createTag(run.ctx, run.scope, { name: id });
    },
  });
  return { ENTERPRISE_PHASES: [phase('model'), phase('content')] };
});

const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };
const ADMIN: Principal = { spaceId: '*', kind: 'admin', scopes: [...scopesForKind('cma')] };

function makeDeps(demoStarters: boolean): McpDeps & { ctx: AppContext } {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  return {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher,
    adminToken: 'admin',
    blob: new FakeBlobStore(),
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    demoStarters,
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

const text = (res: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((res.content as { text: string }[])[0]?.text ?? 'null');

async function drain(ctx: AppContext) {
  const store = ctx.store as InMemoryContentStore;
  const deps = { sender: new RecordingWebhookSender(), starterChunk: starterChunkRunner(ctx) };
  let dispatched = 0;
  while (store.allEvents().length > dispatched) {
    const batch = store.allEvents().slice(dispatched);
    dispatched += batch.length;
    for (const e of batch) await dispatchEvent(ctx, deps, e as DomainEvent);
  }
}

const enterprise = { spaceId: 'acme', name: 'Acme', defaultLocale: 'en-US', starter: 'enterprise' };

describe('starter tools over MCP', () => {
  it('refuses the enterprise starter where the deployment does not offer it', async () => {
    const deps = makeDeps(false);
    const admin = await connect(deps, ADMIN);
    const res = await admin.callTool({ name: 'space_create', arguments: enterprise });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/not available on this deployment/);
    expect(await deps.ctx.store.spaces.getConfig({ spaceId: 'acme', environmentId: 'main' })).toBe(
      null,
    );
    const list = text(await admin.callTool({ name: 'space_starters_list', arguments: {} }));
    expect(list.items.map((s: { id: string }) => s.id)).toEqual(['sample', 'empty']);
  });

  it('creates the space, installs it in the background and follows it to completion', async () => {
    const deps = makeDeps(true);
    const admin = await connect(deps, ADMIN);
    const list = text(await admin.callTool({ name: 'space_starters_list', arguments: {} }));
    expect(list.items.map((s: { id: string }) => s.id)).toEqual(['sample', 'empty', 'enterprise']);

    const created = text(await admin.callTool({ name: 'space_create', arguments: enterprise }));
    expect(created).toMatchObject({ id: 'acme', starter: 'enterprise', installing: { steps: 2 } });
    const get = async () =>
      text(
        await admin.callTool({
          name: 'starter_install_get',
          arguments: {
            space: 'acme',
            environment: 'main',
            install: created.installing.install,
          },
        }),
      );
    expect(await get()).toMatchObject({ status: 'running', step: 1, phase: 'model' });
    await drain(deps.ctx);
    expect(await get()).toMatchObject({ status: 'completed', step: 2, phase: 'content' });
  });

  it("refuses the starters list to a space's own key, and another space's install", async () => {
    const deps = makeDeps(true);
    await createSpace(deps.ctx, { spaceId: 'space-1', name: 'One', defaultLocale: 'en-US' });
    const created = text(
      await (await connect(deps, ADMIN)).callTool({ name: 'space_create', arguments: enterprise }),
    );
    const key = await connect(deps, {
      spaceId: 'space-1',
      kind: 'cma',
      scopes: [...scopesForKind('cma')],
    });
    expect((await key.callTool({ name: 'space_starters_list', arguments: {} })).isError).toBe(true);
    const other = await key.callTool({
      name: 'starter_install_get',
      arguments: { space: 'acme', environment: 'main', install: created.installing.install },
    });
    expect(other.isError).toBe(true);
  });
});
