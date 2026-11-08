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
import { type FieldDefinition, type Principal, SCOPES } from '@commerceworker/domain';
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
};

async function connect(principal: Principal) {
  const store = new InMemoryContentStore();
  const ctx: AppContext = {
    store,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
    passwords: new FakePasswordHasher(),
  };
  const deps: McpDeps = {
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
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ] as FieldDefinition[],
  });
  await publishContentType(ctx, scope, 'note');
  const ids: string[] = [];
  for (const t of ['A', 'B']) {
    ids.push(
      (
        await createEntry(ctx, scope, {
          contentTypeApiId: 'note',
          fields: { title: { 'en-US': t } },
        })
      ).entry.id,
    );
  }
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
    return {
      isError: r.isError === true,
      text: r.content?.find((c) => c.type === 'text')?.text ?? '',
    };
  };
  return { client, call, store, ids };
}

describe('entries_move', () => {
  it('moves an entry as the route does, for a caller with content:write', async () => {
    const { client, call, store, ids } = await connect(editor);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('entries_move');
    const [a, b] = ids as [string, string];
    const res = await call('entries_move', { id: b, after: null });
    expect(res.isError).toBe(false);
    const order = (
      await store.entries.list(scope, {
        contentTypeApiId: 'note',
        order: [{ field: 'sys.position', direction: 'asc' }],
      })
    ).map((e) => e.entry.id);
    expect(order).toEqual([b, a]);
  });

  it('asks for exactly one of after and before', async () => {
    const { call, ids } = await connect(editor);
    const [a, b] = ids as [string, string];
    expect((await call('entries_move', { id: a })).isError).toBe(true);
    expect((await call('entries_move', { id: a, after: b, before: b })).isError).toBe(true);
  });
});
