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
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const reader: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };
const writer: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite],
};
const scope = { spaceId: SPACE, environmentId: 'main' };

async function setup() {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
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
  const field = (apiId: string, type: FieldDefinition['type'], position: number) =>
    ({ apiId, name: apiId, type, localized: false, required: false, position }) as FieldDefinition;
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    urlPattern: '/blog/{slug}',
    fields: [
      field('title', 'Symbol', 0),
      field('slug', 'Slug', 1),
      field('seo', 'Seo', 2),
      field('internalNotes', 'Text', 3),
    ],
  });
  await publishContentType(ctx, scope, 'article');
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: {
      title: { 'en-US': 'Hello' },
      slug: { 'en-US': 'hello' },
      internalNotes: { 'en-US': 'Do not share' },
    },
  });
  await publishEntry(ctx, scope, entry.id);
  return { ctx, deps, id: entry.id };
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

describe('SEO tools (MCP), on the HTTP routes’ use-cases', () => {
  it('sets an entry’s SEO metadata as a draft that the sitemap follows once published', async () => {
    const { ctx, deps, id } = await setup();
    const call = await connect(deps, admin);
    const saved = await call('entries_set_seo', { id, title: 'Hello | Blog', noindex: true });
    expect(saved.isError).toBe(false);
    expect((saved.body as { fields: { seo: unknown } }).fields.seo).toEqual({
      'en-US': { title: 'Hello | Blog', noindex: true },
    });
    const listed = async () =>
      ((await call('sitemap_list')).body as { items: { urls: { path: string }[] }[] }).items;
    expect((await listed()).map((e) => e.urls[0]?.path)).toEqual(['/blog/hello']);
    await publishEntry(ctx, scope, id);
    expect(await listed()).toEqual([]);
    await call('entries_set_seo', { id, noindex: null });
    await publishEntry(ctx, scope, id);
    expect(await listed()).toHaveLength(1);
  });

  it('reports a bad value by its path, as the route does', async () => {
    const { deps, id } = await setup();
    const call = await connect(deps, admin);
    const bad = await call('entries_set_seo', { id, canonicalUrl: 'javascript:alert(1)' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('seo.canonicalUrl');
  });

  it('holds the same scopes as REST: the sitemap needs preview:read, a change content:write', async () => {
    const { deps, id } = await setup();
    const asReader = await connect(deps, reader);
    expect((await asReader('sitemap_list')).isError).toBe(false);
    expect((await asReader('entries_set_seo', { id, title: 'x' })).isError).toBe(true);
    const asWriter = await connect(deps, writer);
    expect((await asWriter('entries_set_seo', { id, title: 'x' })).isError).toBe(false);
  });

  it('answers with only the fields the role may read', async () => {
    const { deps, id } = await setup();
    const masked = await connect(deps, {
      ...writer,
      contentGrants: [
        {
          contentTypeApiId: 'article',
          actions: ['read', 'write'],
          deniedFields: ['internalNotes'],
        },
      ],
    });
    const res = await masked('entries_set_seo', { id, title: 'x' });
    expect(res.isError).toBe(false);
    const fields = (res.body as { fields: Record<string, unknown> }).fields;
    expect(fields).not.toHaveProperty('internalNotes');
    expect(fields.seo).toEqual({ 'en-US': { title: 'x' } });
  });

  it('declares the sitemap a read and the change a write', async () => {
    const { deps } = await setup();
    const server = buildServer(deps, admin);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const read = (name: string) => tools.find((t) => t.name === name)?.annotations?.readOnlyHint;
    expect(read('sitemap_list')).toBe(true);
    expect(read('entries_set_seo')).toBeUndefined();
  });
});
