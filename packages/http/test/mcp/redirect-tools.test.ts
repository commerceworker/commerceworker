import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { type AppContext, createSpace } from '@commerceworker/application';
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
const manager: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentManage],
};

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

describe('redirect tools (MCP), on the HTTP routes’ use-cases', () => {
  it('manages redirects end to end', async () => {
    const { deps } = await setup();
    const call = await connect(deps, admin);
    const made = (await call('redirects_create', { source: '/b', destination: '/c' })).body as {
      redirect: { id: string };
    };
    const chained = (await call('redirects_create', { source: '/a', destination: '/b' })).body as {
      chains: unknown[];
    };
    expect(chained.chains).toHaveLength(1);
    expect((await call('redirects_analyze')).body).toMatchObject({ loops: [], count: 2 });
    expect((await call('redirects_collapse_chains')).body).toEqual({ updated: 1 });
    expect((await call('redirects_resolve', { path: '/a?x=1' })).body).toMatchObject({
      location: '/c?x=1',
    });
    expect((await call('redirects_resolve', { path: '/zzz' })).text).toBe('null');
    await call('redirects_update', { id: made.redirect.id, enabled: false });
    expect((await call('redirects_get', { id: made.redirect.id })).body).toMatchObject({
      enabled: false,
    });
    const imported = (
      await call('redirects_import', {
        format: 'csv',
        data: 'source,destination\n/blog/[slug],/posts/[slug]\n',
      })
    ).body as { created: number };
    expect(imported.created).toBe(1);
    const list = (await call('redirects_list', { q: 'blog' })).body as {
      items: { source: string }[];
    };
    expect(list.items.map((r) => r.source)).toEqual(['/blog/[slug]']);
    expect((await call('redirects_delete', { id: made.redirect.id })).body).toEqual({
      deleted: made.redirect.id,
    });
  });

  it('refuses a loop as the route does', async () => {
    const { deps } = await setup();
    const call = await connect(deps, admin);
    await call('redirects_create', { source: '/a', destination: '/b' });
    const loop = await call('redirects_create', { source: '/b', destination: '/a' });
    expect(loop.isError).toBe(true);
  });

  it('holds the same scopes as REST: reading needs preview:read, changing content:manage', async () => {
    const { deps } = await setup();
    const asReader = await connect(deps, reader);
    expect((await asReader('redirects_list')).isError).toBe(false);
    expect((await asReader('redirects_resolve', { path: '/a' })).isError).toBe(false);
    expect((await asReader('redirects_create', { source: '/a', destination: '/b' })).isError).toBe(
      true,
    );
    expect(
      (await asReader('redirects_import', { format: 'csv', data: 'source,destination\n' })).isError,
    ).toBe(true);
    const asManager = await connect(deps, manager);
    expect((await asManager('redirects_create', { source: '/a', destination: '/b' })).isError).toBe(
      false,
    );
  });

  it('sets a URL pattern on a content type', async () => {
    const { deps } = await setup();
    const call = await connect(deps, admin);
    const ct = (
      await call('model_create_content_type', {
        apiId: 'post',
        name: 'Post',
        displayField: 'title',
        urlPattern: '/blog/{slug}',
        fields: [
          { apiId: 'title', name: 'Title', type: 'Symbol', position: 0 },
          { apiId: 'slug', name: 'Slug', type: 'Slug', position: 1 },
        ],
      })
    ).body as { urlPattern?: string };
    expect(ct.urlPattern).toBe('/blog/{slug}');
  });
});
