import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createSpace,
  deliveryReads,
  listDeliveredRoutes,
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

const SPACE = 'site';
const scope = { spaceId: SPACE, environmentId: 'main' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const field = (apiId: string, type: string, position: number) => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position,
});
const definition = {
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  urlPattern: '/{slug}',
  fields: [field('title', 'Symbol', 0), field('slug', 'Slug', 1)],
};

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
    blob: new FakeBlobStore(),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  const server = buildServer(deps, admin);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    expect(r.isError).not.toBe(true);
    return JSON.parse(r.content?.find((c) => c.type === 'text')?.text ?? 'null') as unknown;
  };
  return { ctx, call };
}

describe('a draft revision over MCP', () => {
  it('holds Delivery as last published until model_publish_content_type', async () => {
    const { ctx, call } = await setup();
    await call('model_create_content_type', definition);
    await call('model_publish_content_type', { apiId: 'page' });

    const draft = await call('model_create_content_type', {
      ...definition,
      urlPattern: '/pages/{slug}',
      fields: [...definition.fields, field('subtitle', 'Symbol', 2)],
    });
    expect(draft).toMatchObject({ status: 'draft', version: 2, urlPattern: '/pages/{slug}' });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
    const live = async () =>
      (await deliveryReads(ctx).read(scope, { contentTypes: true })).contentTypes?.[0];
    expect((await live())?.fields.map((f) => f.apiId)).toEqual(['title', 'slug']);

    await call('model_publish_content_type', { apiId: 'page' });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'page', urlPattern: '/pages/{slug}' },
    ]);
    expect((await live())?.fields.map((f) => f.apiId)).toEqual(['title', 'slug', 'subtitle']);
  });
});
