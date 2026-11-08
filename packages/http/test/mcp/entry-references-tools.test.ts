// Filter by referenced entry over MCP: entries_query's ref/refIn filters and linksToEntry, the
// tool side of fields.<link>[ref] and links_to_entry, with the same checks.
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
import { type Principal, SCOPES } from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const READER: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };
const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };

function makeDeps(): McpDeps {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  return {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher,
    adminToken: 'admin',
    blob: new FakeBlobStore(),
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
  };
}

async function connect(deps: McpDeps, principal: Principal): Promise<Client> {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const text = (res: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((res.content as { text: string }[])[0]?.text ?? 'null');

interface Page {
  items: { id: string; fields: { title: Record<string, string> } }[];
}

const titles = (res: Awaited<ReturnType<Client['callTool']>>) =>
  (text(res) as Page).items.map((e) => e.fields.title['en-US']).sort();

describe('reference filters over MCP', () => {
  let deps: McpDeps;
  let ann = '';
  let bob = '';
  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'One', defaultLocale: 'en-US' });
    const sym = (apiId: string) => ({
      apiId,
      name: apiId,
      type: 'Symbol' as const,
      localized: false,
      required: false,
      position: 0,
    });
    await createContentType(deps.ctx, SYSTEM_CALLER, scope, {
      apiId: 'person',
      name: 'Person',
      displayField: 'name',
      fields: [sym('name')],
    });
    await createContentType(deps.ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [
        sym('title'),
        {
          apiId: 'author',
          name: 'Author',
          type: 'Link',
          linkType: 'Entry',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
    await publishContentType(deps.ctx, scope, 'person');
    await publishContentType(deps.ctx, scope, 'note');
    const make = async (contentTypeApiId: string, fields: Record<string, unknown>) =>
      (
        await createEntry(deps.ctx, scope, {
          contentTypeApiId,
          fields: Object.fromEntries(
            Object.entries(fields).map(([k, v]) => [k, { 'en-US': v }]),
          ) as never,
        })
      ).entry.id;
    ann = await make('person', { name: 'Ann' });
    bob = await make('person', { name: 'Bob' });
    await make('note', { title: 'By Ann', author: { id: ann, linkType: 'Entry' } });
    await make('note', { title: 'By Bob', author: { id: bob, linkType: 'Entry' } });
    await make('note', { title: 'Nobody' });
  });

  const query = (client: Client, args: Record<string, unknown>) =>
    client.callTool({
      name: 'entries_query',
      arguments: { space: SPACE, contentType: 'note', ...args },
    });

  it('ref and refIn filter a link field, linksToEntry any field', async () => {
    const client = await connect(deps, READER);
    expect(
      titles(await query(client, { filters: [{ field: 'author', op: 'ref', value: ann }] })),
    ).toEqual(['By Ann']);
    expect(
      titles(
        await query(client, {
          filters: [{ field: 'fields.author', op: 'refIn', value: [ann, bob] }],
        }),
      ),
    ).toEqual(['By Ann', 'By Bob']);
    expect(titles(await query(client, { linksToEntry: [bob] }))).toEqual(['By Bob']);
  });

  it('refuses a malformed reference filter as the query string does', async () => {
    const client = await connect(deps, READER);
    for (const filters of [
      [{ field: 'author', op: 'ref', value: [ann] }],
      [{ field: 'author', op: 'refIn', value: [] }],
      [{ field: '*', op: 'eq', value: ann }],
    ]) {
      const res = await query(client, { filters });
      expect(res.isError, JSON.stringify(filters)).toBe(true);
    }
  });

  it('refuses linksToEntry to a principal with a hidden field', async () => {
    const restricted: Principal = {
      ...READER,
      contentGrants: [{ contentTypeApiId: 'note', actions: ['read'], deniedFields: ['secret'] }],
    };
    const client = await connect(deps, restricted);
    expect((await query(client, { linksToEntry: [ann] })).isError).toBe(true);
    expect(
      titles(await query(client, { filters: [{ field: 'author', op: 'ref', value: ann }] })),
    ).toEqual(['By Ann']);
  });
});
