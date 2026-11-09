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
const manager: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentManage],
};

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

describe('menu tools (MCP), on the HTTP routes’ use-cases', () => {
  it('manages a menu end to end and reads it as Delivery serves it', async () => {
    const { ctx, deps } = await setup();
    const scope = { spaceId: SPACE, environmentId: 'main' };
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      urlPattern: '/{slug}',
      fields: [field('title', 'Symbol', 0), field('slug', 'Slug', 1)] as never,
    });
    await publishContentType(ctx, scope, 'page');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'About' }, slug: { 'en-US': 'about' } },
    });
    await publishEntry(ctx, scope, entry.id);

    const call = await connect(deps, admin);
    const made = (
      await call('menus_create', {
        handle: 'main',
        name: 'Main',
        items: [
          { id: 'home', label: 'Home', link: { type: 'url', url: '/' } },
          { id: 'about', link: { type: 'entry', entryId: entry.id } },
        ],
      })
    ).body as { id: string; revision: number };
    expect(made.revision).toBe(1);
    expect((await call('menus_list')).body).toMatchObject({ total: 1, items: [{ itemCount: 2 }] });
    const moved = (
      await call('menus_move_item', { id: made.id, itemId: 'about', parentId: null, index: 0 })
    ).body as { items: { id: string }[]; revision: number };
    expect(moved.items.map((i) => i.id)).toEqual(['about', 'home']);
    expect((await call('menus_update', { id: made.id, name: 'Stale', revision: 1 })).isError).toBe(
      true,
    );
    await call('menus_update', { id: made.id, name: 'Header', revision: moved.revision });
    expect((await call('menus_get', { id: made.id })).body).toMatchObject({ name: 'Header' });
    expect((await call('menus_preview', { id: made.id })).body).toMatchObject({
      items: [
        { id: 'about', status: 'live', url: '/about' },
        { id: 'home', status: 'live' },
      ],
    });
    expect((await call('menus_resolve', { handle: 'main' })).body).toMatchObject({
      handle: 'main',
      items: [
        { id: 'about', label: 'About', url: '/about' },
        { id: 'home', url: '/' },
      ],
    });
    expect((await call('menus_delete', { id: made.id })).body).toEqual({ deleted: made.id });
    expect((await call('menus_get', { id: made.id })).isError).toBe(true);
  });

  it('refuses a bad item as the route does', async () => {
    const { deps } = await setup();
    const call = await connect(deps, admin);
    const bad = await call('menus_create', {
      handle: 'main',
      name: 'Main',
      items: [{ label: 'x', link: { type: 'url', url: 'javascript:alert(1)' } }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/items\[0\]\.link\.url/);
  });

  it('holds the same scopes as REST: reading needs preview:read, changing content:manage', async () => {
    const { deps } = await setup();
    const asManager = await connect(deps, manager);
    const made = (await asManager('menus_create', { handle: 'main', name: 'Main' })).body as {
      id: string;
    };
    const asReader = await connect(deps, reader);
    expect((await asReader('menus_list')).isError).toBe(false);
    expect((await asReader('menus_resolve', { handle: 'main' })).isError).toBe(false);
    expect((await asReader('menus_create', { handle: 'x', name: 'X' })).isError).toBe(true);
    expect((await asReader('menus_delete', { id: made.id })).isError).toBe(true);
  });
});
