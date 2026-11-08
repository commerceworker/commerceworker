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
/** A key that may read only `page` entries. */
const pagesOnly: Principal = {
  spaceId: SPACE,
  kind: 'cda',
  scopes: [SCOPES.deliveryRead, SCOPES.previewRead],
  contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }],
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

const title = {
  apiId: 'title',
  name: 'Title',
  type: 'Symbol',
  position: 0,
  localized: false,
  required: false,
};

/** `singleton_get` and the `singleton` flag on `model_create_content_type`. */
describe('singleton MCP tools', () => {
  it('makes a singleton type and reads its entry by type, draft or published', async () => {
    const { deps } = await setup();
    const call = await connect(deps, admin);
    const created = await call('model_create_content_type', {
      apiId: 'settings',
      name: 'Settings',
      displayField: 'title',
      fields: [title],
      singleton: true,
    });
    expect(created.isError).toBe(false);
    expect(created.body).toMatchObject({ singleton: true });
    await call('model_publish_content_type', { apiId: 'settings' });

    const one = await call('entries_create', {
      contentType: 'settings',
      fields: { title: { 'en-US': 'Site' } },
    });
    const id = (one.body as { entry: { id: string } }).entry.id;
    const again = await call('entries_create', {
      contentType: 'settings',
      fields: { title: { 'en-US': 'Again' } },
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain(id);

    const draft = await call('singleton_get', { contentType: 'settings', locale: 'en-US' });
    expect(draft.body).toMatchObject({ id, status: 'draft', fields: { title: 'Site' } });
    const unpublished = await call('singleton_get', { contentType: 'settings', published: true });
    expect(unpublished.isError).toBe(true);

    await call('entries_publish', { id });
    const live = await call('singleton_get', {
      contentType: 'settings',
      published: true,
      locale: 'en-US',
    });
    expect(live.body).toMatchObject({ id, fields: { title: 'Site' } });

    // A preview-only key can't read what Delivery serves; a key without the type, neither.
    const asReader = await connect(deps, reader);
    expect((await asReader('singleton_get', { contentType: 'settings' })).isError).toBe(false);
    expect(
      (await asReader('singleton_get', { contentType: 'settings', published: true })).isError,
    ).toBe(true);
    const asPages = await connect(deps, pagesOnly);
    expect((await asPages('singleton_get', { contentType: 'settings' })).isError).toBe(true);
  });
});
