import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  entryTrashChunkRunner,
  publishContentType,
  runBulkChunk,
  SYSTEM_CALLER,
  trashEntry,
} from '@commerceworker/application';
import {
  type BulkChunkDueEvent,
  type Principal,
  rolePresetDefinition,
  SCOPES,
} from '@commerceworker/domain';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import {
  FakeBlobStore,
  FakePasswordHasher,
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

const SPACE = 'space-1';
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const reader: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };

async function setup() {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('n'),
    passwords: new FakePasswordHasher(),
  };
  const blob = new FakeBlobStore();
  const deps: McpDeps = {
    ...inMemoryEdge(),
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob,
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  return { ctx, deps };
}

async function connect(deps: McpDeps, principal: Principal) {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? 'null';
    return {
      isError: r.isError === true,
      body: JSON.parse(text.startsWith('{') || text.startsWith('[') ? text : 'null') as never,
      text,
    };
  };
  return call;
}

const field = (apiId: string, type: string, position: number) => ({
  apiId,
  name: apiId,
  type,
  position,
  localized: false,
  required: false,
});

async function seeded() {
  const { ctx, deps } = await setup();
  const scope = { spaceId: SPACE, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'note',
    name: 'Note',
    displayField: 'title',
    fields: [{ ...field('title', 'Symbol', 0), required: true }] as never,
  });
  await publishContentType(ctx, scope, 'note');
  const ids: string[] = [];
  for (const title of ['a', 'b']) {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': title } },
    });
    ids.push(entry.id);
  }
  /** Runs every chunk the outbox holds, as the engine's bulk consumer would. */
  const runChunks = async () => {
    const store = ctx.store as InMemoryContentStore;
    for (const e of store.allEvents().filter((x) => x.type === 'bulk.chunk_due')) {
      await runBulkChunk(ctx, e as BulkChunkDueEvent, {
        entryTrashChunk: entryTrashChunkRunner(ctx, { blob: deps.blob }),
      });
    }
  };
  return { ctx, deps, scope, ids, runChunks };
}

describe('bulk trash jobs (MCP), on the HTTP route’s use-case', () => {
  it('restores and purges a selection through bulk_job_start', async () => {
    const { ctx, deps, scope, ids, runChunks } = await seeded();
    const [a = '', b = ''] = ids;
    await trashEntry(ctx, scope, a);
    await trashEntry(ctx, scope, b);
    const call = await connect(deps, admin);

    const restore = await call('bulk_job_start', { action: 'restore', entryIds: [a] });
    expect(restore.isError).toBe(false);
    expect(restore.body).toMatchObject({ action: 'restore', totalItems: 1 });
    await runChunks();
    expect((await ctx.store.entries.get(scope, a))?.entry.status).toBe('draft');

    const purge = await call('bulk_job_start', { action: 'purge', entryIds: [a, b] });
    const job = purge.body as { id: string };
    await runChunks();
    // Purging works only from the trash: the restored entry is refused, the trashed one goes.
    expect((await ctx.store.entries.get(scope, a))?.entry.status).toBe('draft');
    expect(await ctx.store.entries.get(scope, b)).toBeNull();
    expect((await call('bulk_job_report', { id: job.id })).body).toMatchObject({
      job: { succeeded: 1, failed: 1 },
    });
  });

  it('lets the Administrator preset start every entry job, and not a narrower role', async () => {
    const { deps, ids } = await seeded();
    const preset = rolePresetDefinition('admin');
    const member: Principal = {
      spaceId: SPACE,
      kind: 'user',
      scopes: [...preset.scopes],
      contentGrants: preset.contentGrants,
    };
    const call = await connect(deps, member);
    for (const action of ['trash', 'restore', 'purge', 'publish']) {
      const r = await call('bulk_job_start', { action, entryIds: ids });
      expect(r.isError, action).toBe(false);
    }
    const narrower = await connect(deps, {
      ...member,
      contentGrants: [{ contentTypeApiId: 'note', actions: ['read', 'write', 'publish'] }],
    });
    expect((await narrower('bulk_job_start', { action: 'trash', entryIds: ids })).isError).toBe(
      true,
    );
  });

  it('needs content:publish to start one', async () => {
    const { deps, ids } = await seeded();
    const call = await connect(deps, reader);
    expect((await call('bulk_job_start', { action: 'trash', entryIds: ids })).isError).toBe(true);
  });
});

describe('trash retention (MCP), on the HTTP routes’ use-cases', () => {
  it('reads and sets the window, off by default', async () => {
    const { deps } = await setup();
    const call = await connect(deps, admin);
    expect((await call('trash_settings_get')).body).toEqual({ retentionDays: null });
    expect((await call('trash_settings_set', { retentionDays: 14 })).body).toEqual({
      retentionDays: 14,
    });
    expect((await call('trash_settings_get')).body).toEqual({ retentionDays: 14 });
    expect((await call('trash_settings_set', { retentionDays: null })).body).toEqual({
      retentionDays: null,
    });
    expect((await call('trash_settings_set', { retentionDays: 0 })).isError).toBe(true);
  });

  it('needs space:admin to set it', async () => {
    const { deps } = await setup();
    const call = await connect(deps, reader);
    expect((await call('trash_settings_get')).isError).toBe(false);
    expect((await call('trash_settings_set', { retentionDays: 7 })).isError).toBe(true);
  });
});
