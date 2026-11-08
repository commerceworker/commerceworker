import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  publishContentType,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import { type Principal, SCOPES } from '@commerceworker/domain';
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

describe('entries_validate (MCP), on the HTTP route’s use-case', () => {
  async function seeded() {
    const { ctx, deps } = await setup();
    const scope = { spaceId: SPACE, environmentId: 'main' };
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [
        { ...field('title', 'Symbol', 0), required: true },
        { ...field('slug', 'Slug', 1), unique: true },
      ] as never,
    });
    await publishContentType(ctx, scope, 'post');
    return { ctx, deps, scope };
  }

  it('answers what a create would store, and writes nothing', async () => {
    const { ctx, deps, scope } = await seeded();
    const call = await connect(deps, admin);
    const r = await call('entries_validate', {
      contentType: 'post',
      fields: { title: { 'en-US': 'Hi' }, slug: { 'en-US': 'Hi There' } },
    });
    expect(r.isError).toBe(false);
    expect(r.body).toEqual({
      valid: true,
      fields: { title: { 'en-US': 'Hi' }, slug: { 'en-US': 'hi-there' } },
      skippedHooks: [],
    });
    expect(await ctx.store.entries.list(scope, {})).toHaveLength(0);
  });

  it('fails as entries_create and entries_update would', async () => {
    const { ctx, deps, scope } = await seeded();
    const call = await connect(deps, admin);
    const missing = await call('entries_validate', { contentType: 'post', fields: {} });
    const created = await call('entries_create', { contentType: 'post', fields: {} });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe(created.text);

    await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'One' }, slug: { 'en-US': 'about' } },
    });
    const two = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Two' } },
    });
    const fields = { title: { 'en-US': 'Two' }, slug: { 'en-US': 'about' } };
    const taken = await call('entries_validate', { id: two.entry.id, fields });
    const updated = await call('entries_update', { id: two.entry.id, fields });
    expect(taken.isError).toBe(true);
    expect(taken.text).toBe(updated.text);
  });

  it('is gated like a save', async () => {
    const { deps } = await seeded();
    const call = await connect(deps, reader);
    const r = await call('entries_validate', {
      contentType: 'post',
      fields: { title: { 'en-US': 'x' } },
    });
    expect(r.isError).toBe(true);
  });
});
