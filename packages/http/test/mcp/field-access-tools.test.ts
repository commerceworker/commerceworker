import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getEntry,
  publishContentType,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import { type FieldDefinition, type Principal, SCOPES } from '@commerceworker/domain';
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
const scope = { spaceId: SPACE, environmentId: 'main' };
// May not read internalNotes, may read but not write price, which is required.
const writer: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite],
  contentGrants: [
    {
      contentTypeApiId: 'listing',
      actions: ['read', 'write'],
      deniedFields: ['internalNotes'],
      readOnlyFields: ['price'],
    },
  ],
};
// Holds the coarse write scope, but its role only reads the type.
const reader: Principal = {
  ...writer,
  contentGrants: [{ contentTypeApiId: 'listing', actions: ['read'] }],
};

async function setup(principal: Principal = writer) {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
    passwords: new FakePasswordHasher(),
  };
  const deps: McpDeps = {
    ...inMemoryEdge(),
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob: new FakeBlobStore(),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  const field = (apiId: string, type: FieldDefinition['type'], position: number) =>
    ({ apiId, name: apiId, type, localized: false, required: false, position }) as FieldDefinition;
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'listing',
    name: 'Listing',
    displayField: 'title',
    fields: [
      field('title', 'Symbol', 0),
      field('internalNotes', 'Text', 1),
      { ...field('price', 'Number', 2), required: true },
    ],
  });
  await publishContentType(ctx, scope, 'listing');
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'listing',
    fields: {
      title: { 'en-US': 'A' },
      internalNotes: { 'en-US': 'secret' },
      price: { 'en-US': 100 },
    },
  });

  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? 'null';
    return { isError: r.isError === true, text };
  };
  return { ctx, id: entry.id, call };
}

describe('a restricted writer over MCP', () => {
  it('keeps the fields it may not write when it saves, and answers without the hidden ones', async () => {
    const { ctx, id, call } = await setup();
    const edit = { title: { 'en-US': 'B' } };

    const checked = await call('entries_validate', { id, fields: edit });
    expect(checked.isError, checked.text).toBe(false);
    expect(JSON.parse(checked.text).fields).toEqual({
      title: { 'en-US': 'B' },
      price: { 'en-US': 100 },
    });

    // price is required and read-only: the save keeps it rather than failing without it.
    const saved = await call('entries_update', { id, fields: edit });
    expect(saved.isError, saved.text).toBe(false);
    expect(JSON.parse(saved.text).fields).toEqual({
      title: { 'en-US': 'B' },
      price: { 'en-US': 100 },
    });
    expect(saved.text).not.toContain('secret');

    const stored = await getEntry(ctx, scope, id);
    expect(stored.entry.currentVersion).toBe(2);
    expect(stored.fields).toEqual({
      title: { 'en-US': 'B' },
      internalNotes: { 'en-US': 'secret' },
      price: { 'en-US': 100 },
    });
  });

  it('still refuses a write to a field it may not write', async () => {
    const { call, id } = await setup();
    const res = await call('entries_update', {
      id,
      fields: { title: { 'en-US': 'B' }, price: { 'en-US': 1 } },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('listing.price');
  });

  it('duplicates without the fields it may not read; the copy keeps them', async () => {
    const { ctx, call, id } = await setup();
    const res = await call('entries_duplicate', { id });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).not.toContain('secret');
    const copy = JSON.parse(res.text);
    expect(copy.fields).toEqual({ title: { 'en-US': 'A (copy)' }, price: { 'en-US': 100 } });

    const stored = await getEntry(ctx, scope, copy.entry.id);
    expect(stored.fields.internalNotes).toEqual({ 'en-US': 'secret' });
  });

  it('refuses a duplicate without write on the type, and leaves no copy behind', async () => {
    const { ctx, call, id } = await setup(reader);
    const res = await call('entries_duplicate', { id });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('content:write:listing');
    expect(await ctx.store.entries.list(scope, { contentTypeApiId: 'listing' })).toHaveLength(1);
  });
});
