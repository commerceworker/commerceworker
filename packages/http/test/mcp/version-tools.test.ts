import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { type AppContext, createSpace } from '@commerceworker/application';
import { type Principal, SCOPES } from '@commerceworker/domain';
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
    ids: new SequenceIdGenerator('m'),
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

interface Diff {
  from: number;
  to: number;
  changes: { field: string; name?: string; kind: string; locales: { detail?: unknown }[] }[];
}

async function seedEntry(call: Awaited<ReturnType<typeof connect>>) {
  await call('model_create_content_type', {
    apiId: 'post',
    name: 'Post',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Headline',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  });
  await call('model_publish_content_type', { apiId: 'post' });
  const created = (
    await call('entries_create', {
      contentType: 'post',
      fields: { title: { 'en-US': 'Old headline' } },
    })
  ).body as { entry: { id: string } };
  const id = created.entry.id;
  await call('entries_publish', { id });
  await call('entries_update', { id, fields: { title: { 'en-US': 'New headline' } } });
  return id;
}

describe('entries_diff_versions (MCP), on the HTTP route’s use-case', () => {
  it('compares published with the draft, with the same typed detail as REST', async () => {
    const { deps } = await setup();
    const call = await connect(deps, admin);
    const id = await seedEntry(call);
    const r = await call('entries_diff_versions', { id, from: 'published', to: 'draft' });
    expect(r.isError, r.text).toBe(false);
    const diff = r.body as Diff;
    expect([diff.from, diff.to]).toEqual([1, 2]);
    expect(diff.changes[0]).toMatchObject({ field: 'title', name: 'Headline', kind: 'changed' });
    expect(diff.changes[0]?.locales[0]?.detail).toEqual({
      type: 'text',
      segments: [
        { kind: 'removed', text: 'Old' },
        { kind: 'added', text: 'New' },
        { kind: 'unchanged', text: ' headline' },
      ],
    });
  });

  it('accepts version numbers and refuses what is not a version', async () => {
    const { deps } = await setup();
    const call = await connect(deps, admin);
    const id = await seedEntry(call);
    expect((await call('entries_diff_versions', { id, from: 1, to: 2 })).isError).toBe(false);
    expect((await call('entries_diff_versions', { id, from: 'latest', to: 2 })).isError).toBe(true);
    expect((await call('entries_diff_versions', { id, from: 0, to: 2 })).isError).toBe(true);
    expect((await call('entries_diff_versions', { id, from: 1, to: 7 })).isError).toBe(true);
  });

  it('needs preview:read, and as a read leaves nothing in the audit trail', async () => {
    const { deps } = await setup();
    const id = await seedEntry(await connect(deps, admin));
    const before = (await deps.ctx.store.audit.list(SPACE, {})).length;
    const asReader = await connect(deps, reader);
    expect((await asReader('entries_diff_versions', { id, from: 1, to: 'draft' })).isError).toBe(
      false,
    );
    expect((await deps.ctx.store.audit.list(SPACE, {})).length).toBe(before);
    const none: Principal = { spaceId: SPACE, kind: 'cma', scopes: [SCOPES.contentWrite] };
    const asWriter = await connect(deps, none);
    expect((await asWriter('entries_diff_versions', { id, from: 1, to: 'draft' })).isError).toBe(
      true,
    );
  });
});
