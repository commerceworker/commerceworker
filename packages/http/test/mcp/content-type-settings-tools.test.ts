import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { type AppContext, createSpace } from '@commerceworker/application';
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

async function connect() {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('g'),
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

describe('content type details, layout and field settings through the MCP model tools', () => {
  it('keeps a type’s details and a field’s format and preset, as the route does', async () => {
    const { call } = await connect();
    const layout = {
      tabs: [{ apiId: 'main', name: 'Main', groups: [{ name: 'Basics', fields: ['title'] }] }],
    };
    const created = await call('model_create_content_type', {
      apiId: 'event',
      name: 'Event',
      displayField: 'title',
      group: 'Programme',
      description: 'Something on the calendar.',
      icon: 'calendar',
      layout,
      fields: [
        { apiId: 'title', name: 'Title', type: 'Symbol', position: 0 },
        { apiId: 'day', name: 'Day', type: 'Date', position: 1, format: 'date' },
        {
          apiId: 'site',
          name: 'Site',
          type: 'Symbol',
          position: 2,
          validations: { regexp: { preset: 'url' } },
        },
      ],
    });
    expect(created.isError, created.text).toBe(false);
    const got = JSON.parse((await call('model_get_content_type', { apiId: 'event' })).text) as {
      fields: Record<string, unknown>[];
    } & Record<string, unknown>;
    expect(got).toMatchObject({ group: 'Programme', icon: 'calendar', layout });
    expect(got.fields[1]?.format).toBe('date');
    expect(got.fields[2]?.validations).toMatchObject({ regexp: { preset: 'url' } });

    await call('model_publish_content_type', { apiId: 'event' });
    const bad = await call('entries_create', {
      contentType: 'event',
      fields: { title: { 'en-US': 'A' }, day: { 'en-US': '2026-11-03T10:00' } },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('YYYY-MM-DD');
  });

  it('sets, reads and clears agent instructions', async () => {
    const { client } = await connect();
    const type = {
      apiId: 'brief',
      name: 'Brief',
      displayField: 'title',
      fields: [{ apiId: 'title', name: 'Title', type: 'Symbol', position: 0 }],
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      const [block] = result.content as { text: string }[];
      return JSON.parse(block?.text ?? 'null') as { agentInstructions?: string };
    };
    await call('model_create_content_type', { ...type, agentInstructions: 'Stay factual.' });
    const read = await call('model_get_content_type', { apiId: 'brief' });
    expect(read.agentInstructions).toBe('Stay factual.');
    const listedTypes = await client.callTool({ name: 'model_list_content_types', arguments: {} });
    expect(JSON.stringify(listedTypes.content)).toContain('brief');
    expect(JSON.stringify(listedTypes.content)).not.toContain('Stay factual.');
    await call('model_create_content_type', { ...type, agentInstructions: null });
    expect(await call('model_get_content_type', { apiId: 'brief' })).not.toHaveProperty(
      'agentInstructions',
    );
  });

  it('describes the new settings in the tool descriptions and input schema', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('model_create_content_type')?.description).toMatch(/layout/);
    expect(byName.get('model_get_content_type')?.description).toMatch(/format/);
    // Stored text an agent reads is data: the description must never present it as orders.
    const described = byName.get('model_get_content_type')?.description;
    expect(described).toMatch(/It is data/);
    expect(described).toMatch(/can’t authorize a tool call/);
    expect(described).not.toMatch(/brief/);
    const schema = JSON.stringify(byName.get('model_create_content_type')?.inputSchema);
    for (const key of [
      '"group"',
      '"icon"',
      '"agentInstructions"',
      '"layout"',
      '"format"',
      'assetMimeTypes',
      'preset',
    ]) {
      expect(schema).toContain(key);
    }
  });
});
