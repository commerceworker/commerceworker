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

const fields = [
  { apiId: 'title', name: 'Title', type: 'Symbol', position: 0, required: true },
  { apiId: 'kind', name: 'Kind', type: 'Symbol', position: 1 },
  {
    apiId: 'url',
    name: 'URL',
    type: 'Symbol',
    position: 2,
    required: true,
    rules: [{ action: 'hide', when: { field: 'kind', operator: 'ne', value: 'link' } }],
  },
];

describe('conditional field rules through the MCP model tools', () => {
  it('keeps the rules an agent writes, and holds entries to them', async () => {
    const { call } = await connect();
    const created = await call('model_create_content_type', {
      apiId: 'card',
      name: 'Card',
      displayField: 'title',
      fields,
    });
    expect(created.isError, created.text).toBe(false);
    await call('model_publish_content_type', { apiId: 'card' });
    const got = JSON.parse((await call('model_get_content_type', { apiId: 'card' })).text) as {
      fields: Record<string, unknown>[];
    };
    expect(got.fields[2]?.rules).toEqual(fields[2]?.rules);

    const hidden = await call('entries_create', {
      contentType: 'card',
      fields: { title: { 'en-US': 'A' }, kind: { 'en-US': 'text' } },
    });
    expect(hidden.isError, hidden.text).toBe(false);
    const shown = await call('entries_create', {
      contentType: 'card',
      fields: { title: { 'en-US': 'A' }, kind: { 'en-US': 'link' } },
    });
    expect(shown.isError).toBe(true);
    expect(shown.text).toContain('url');
  });

  it('refuses an unusable rule, as the route does', async () => {
    const { call } = await connect();
    const res = await call('model_create_content_type', {
      apiId: 'card',
      name: 'Card',
      displayField: 'title',
      fields: [
        fields[0],
        {
          ...fields[2],
          rules: [{ action: 'hide', when: { field: 'kind', operator: 'gt', value: 1 } }],
        },
      ],
    });
    expect(res.isError).toBe(true);
  });

  it('describes rules in the tool descriptions and input schema', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('model_get_content_type')?.description).toMatch(/rules.*hidden field/s);
    expect(byName.get('model_create_content_type')?.description).toMatch(/rules/);
    const schema = JSON.stringify(byName.get('model_create_content_type')?.inputSchema);
    expect(schema).toContain('"rules"');
    expect(schema).toContain('notEmpty');
  });
});
