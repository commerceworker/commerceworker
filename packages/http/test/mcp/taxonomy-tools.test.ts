import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  setEntryMetadata,
} from '@commerceworker/application';
import { type Principal, SCOPES } from '@commerceworker/domain';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import {
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
import { toolMutates } from '../../src/mcp/audit';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const reader: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };

async function setup() {
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
  };
  await createSpace(ctx, {
    spaceId: SPACE,
    name: 'Shop',
    defaultLocale: 'en-US',
    locales: ['en-US', 'de'],
  });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'story',
    name: 'Story',
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
    ],
  });
  await publishContentType(ctx, scope, 'story');
  return { ctx, deps };
}

async function connect(deps: McpDeps, principal: Principal) {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  // The tools that declare themselves reads (`readOnlyHint`), which is what keeps them unaudited.
  const { tools } = await client.listTools();
  const reads = new Set(
    tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name),
  );
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
  return Object.assign(call, { reads });
}

describe('taxonomy tools (MCP), on the HTTP routes’ use-cases', () => {
  it('creates, edits, looks up by slug and counts terms', async () => {
    const { ctx, deps } = await setup();
    const call = await connect(deps, admin);

    const created = await call('taxonomy_create_tag', {
      name: 'Featured',
      description: 'Front page',
      labels: { de: 'Empfohlen' },
    });
    expect(created.isError).toBe(false);
    const tag = created.body as { id: string; slug: string };
    expect(tag.slug).toBe('featured');
    expect((await call('taxonomy_create_tag', { name: 'X', slug: 'featured' })).isError).toBe(true);

    const updated = await call('taxonomy_update_tag', { id: tag.id, name: 'Highlights' });
    expect(updated.body).toMatchObject({ name: 'Highlights', slug: 'featured' });

    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'story',
      fields: { title: { 'en-US': 'One' } },
    });
    await setEntryMetadata(ctx, scope, entry.id, { tags: [tag.id] });
    await publishEntry(ctx, scope, entry.id);

    const listed = (await call('taxonomy_list_tags')).body as {
      id: string;
      usage: { count: number };
    }[];
    expect(listed.find((t) => t.id === tag.id)?.usage.count).toBe(1);
    expect((await call('taxonomy_get_tag', { slug: 'featured', locale: 'de' })).body).toMatchObject(
      {
        label: 'Empfohlen',
        count: 1,
      },
    );

    const scheme = (await call('taxonomy_create_scheme', { name: 'Topics' })).body as {
      id: string;
    };
    const concept = (
      await call('taxonomy_create_concept', {
        schemeId: scheme.id,
        prefLabel: 'Cats',
        slug: 'felines',
      })
    ).body as { id: string };
    expect(
      (await call('taxonomy_update_concept', { id: concept.id, description: 'Purring' })).body,
    ).toMatchObject({ slug: 'felines', description: 'Purring' });
    expect((await call('taxonomy_get_concept', { slug: 'felines' })).body).toMatchObject({
      id: concept.id,
      schemeId: scheme.id,
    });
    expect((await call('taxonomy_repair')).body).toEqual({ slugsAssigned: 0 });
  });

  it('needs content:manage to change the vocabulary, and audits only the writes', async () => {
    const { deps } = await setup();
    const call = await connect(deps, reader);
    expect((await call('taxonomy_create_tag', { name: 'Nope' })).isError).toBe(true);
    expect((await call('taxonomy_list_tags')).isError).toBe(false);
    for (const tool of ['taxonomy_get_tag', 'taxonomy_get_concept', 'taxonomy_list_tags']) {
      expect(toolMutates(tool, {}, call.reads.has(tool)), tool).toBe(false);
    }
    for (const tool of ['taxonomy_update_tag', 'taxonomy_update_concept', 'taxonomy_repair']) {
      expect(toolMutates(tool, {}, call.reads.has(tool)), tool).toBe(true);
    }
  });
});
