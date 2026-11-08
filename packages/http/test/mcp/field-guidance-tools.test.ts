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

async function connect() {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('g'),
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
  const server = buildServer(deps, admin);
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
  return { client, call };
}

const status = {
  apiId: 'status',
  name: 'Status',
  type: 'Symbol',
  position: 1,
  help: 'Where the listing stands today.',
  placeholder: 'open',
  description: 'Drives the badge on the listing card.',
  validations: {
    in: [{ value: 'open', label: 'Open for viewings' }, 'let'],
    messages: { in: 'Pick a status from the list' },
  },
};

describe('field guidance through the MCP model tools', () => {
  it('keeps the guidance an agent writes and hands it back from model_get_content_type', async () => {
    const { call } = await connect();
    const created = await call('model_create_content_type', {
      apiId: 'listing',
      name: 'Listing',
      displayField: 'title',
      fields: [{ apiId: 'title', name: 'Title', type: 'Symbol', position: 0 }, status],
    });
    expect(created.isError).toBe(false);
    await call('model_publish_content_type', { apiId: 'listing' });

    const got = JSON.parse((await call('model_get_content_type', { apiId: 'listing' })).text) as {
      fields: Record<string, unknown>[];
    };
    expect(got.fields[1]).toMatchObject({
      help: status.help,
      placeholder: status.placeholder,
      description: status.description,
      validations: status.validations,
    });

    // An entry written through the same surface is held to the option values and the message.
    const bad = await call('entries_create', {
      contentType: 'listing',
      fields: { title: { 'en-US': 'Flat' }, status: { 'en-US': 'Open for viewings' } },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Pick a status from the list');
    const ok = await call('entries_create', {
      contentType: 'listing',
      fields: { title: { 'en-US': 'Flat' }, status: { 'en-US': 'open' } },
    });
    expect(ok.isError).toBe(false);
  });

  it('refuses guidance over its cap, as the route does', async () => {
    const { call } = await connect();
    const res = await call('model_create_content_type', {
      apiId: 'listing',
      name: 'Listing',
      displayField: 'title',
      fields: [
        { apiId: 'title', name: 'Title', type: 'Symbol', position: 0, help: 'x'.repeat(501) },
      ],
    });
    expect(res.isError).toBe(true);
  });

  it('says so in the tool descriptions and input schema', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['model_get_content_type', 'model_create_content_type']) {
      expect(byName.get(name)?.description).toMatch(/help.*placeholder/s);
    }
    const schema = JSON.stringify(byName.get('model_create_content_type')?.inputSchema);
    for (const key of ['"help"', '"placeholder"', '"description"', 'messages']) {
      expect(schema).toContain(key);
    }
  });
});
