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
import type { FieldDefinition, Principal } from '@commerceworker/domain';
import { SCOPES } from '@commerceworker/domain';
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
const editor: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.contentWrite, SCOPES.previewRead],
  contentGrants: [
    { contentTypeApiId: 'note', actions: ['read', 'write'], readOnlyFields: ['owner'] },
  ],
};

const symbol = (apiId: string, position: number): FieldDefinition =>
  ({
    apiId,
    name: apiId,
    type: 'Symbol',
    localized: false,
    required: false,
    position,
  }) as FieldDefinition;

async function connect(principal: Principal) {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('b'),
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
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'note',
    name: 'Note',
    displayField: 'title',
    fields: [symbol('title', 0), symbol('status', 1), symbol('owner', 2)],
  });
  await publishContentType(ctx, scope, 'note');
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'note',
    fields: { title: { 'en-US': 'A' } },
  });
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
    return { isError: r.isError === true, text };
  };
  return { client, call, entryId: entry.id };
}

describe('bulk field edit through MCP', () => {
  it('starts a set_fields job for a role that writes the type, as the route does', async () => {
    const { client, call, entryId } = await connect(editor);
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).toContain('bulk_job_set_fields');

    const started = await call('bulk_job_set_fields', {
      contentTypeApiId: 'note',
      entryIds: [entryId],
      fields: { status: { 'en-US': 'reviewed' } },
    });
    expect(started.isError).toBe(false);
    expect(JSON.parse(started.text)).toMatchObject({ action: 'set_fields', totalItems: 1 });
    // A key that may start one can follow it, as GET …/bulk/jobs/{id} allows: content:write.
    const { id } = JSON.parse(started.text) as { id: string };
    const status = await call('bulk_job_status', { id });
    expect(status.isError).toBe(false);
    expect(JSON.parse(status.text)).toMatchObject({ id, status: 'running' });
    // The values it sets are field values, read only through entries: never through the job.
    expect(started.text).not.toContain('reviewed');
    expect(status.text).not.toContain('reviewed');
    expect((await call('bulk_job_status', {})).text).not.toContain('reviewed');
  });

  it('refuses a field the role may only read, and a field the type lacks', async () => {
    const { call, entryId } = await connect(editor);
    const readOnly = await call('bulk_job_set_fields', {
      contentTypeApiId: 'note',
      entryIds: [entryId],
      fields: { owner: { 'en-US': 'me' } },
    });
    expect(readOnly.isError).toBe(true);
    expect(readOnly.text).toContain('owner');
    const unknown = await call('bulk_job_set_fields', {
      contentTypeApiId: 'note',
      entryIds: [entryId],
      fields: { colour: { 'en-US': 'red' } },
    });
    expect(unknown.isError).toBe(true);
  });
});
