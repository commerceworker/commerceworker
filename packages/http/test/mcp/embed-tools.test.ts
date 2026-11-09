import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { type AppContext, createSpace } from '@commerceworker/application';
import { type Principal, SCOPES } from '@commerceworker/domain';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import type { RemoteFetcher } from '@commerceworker/ports';
import {
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
const VIDEO = 'https://vimeo.com/76979871';
const writer: Principal = { spaceId: SPACE, kind: 'cma', scopes: [SCOPES.contentWrite] };
const reader: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };
const elsewhere: Principal = { spaceId: 'space-2', kind: 'cma', scopes: [SCOPES.contentWrite] };

function fetcher(): RemoteFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      return {
        status: 200,
        body: JSON.stringify({
          type: 'video',
          title: 'The New Vimeo Player',
          author_name: 'Vimeo Staff',
          html: '<iframe src="https://player.vimeo.com/video/76979871"></iframe>',
        }),
      };
    },
    async getBytes() {
      throw new Error('embed_resolve reads text only');
    },
  };
}

async function setup(remoteFetcher?: RemoteFetcher) {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('e'),
  };
  const deps: McpDeps = {
    ...inMemoryEdge(),
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    ...(remoteFetcher ? { remoteFetcher } : {}),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Shop', defaultLocale: 'en-US' });
  return deps;
}

async function connect(deps: McpDeps, principal: Principal): Promise<Client> {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: ToolResult) => r.content?.find((c) => c.type === 'text')?.text ?? '';

describe('embed_resolve (MCP), on the same use-case as POST …/embeds/resolve', () => {
  it("returns the embed node's structured data, never the provider's html", async () => {
    const remote = fetcher();
    const client = await connect(await setup(remote), writer);
    const result = (await client.callTool({
      name: 'embed_resolve',
      arguments: { url: VIDEO, space: SPACE },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({
      resolved: true,
      embed: {
        url: VIDEO,
        provider: 'vimeo',
        kind: 'video',
        title: 'The New Vimeo Player',
        authorName: 'Vimeo Staff',
      },
    });
    expect(text(result)).not.toMatch(/iframe|html/);
    expect(remote.calls).toHaveLength(1);
  });

  it('refuses a URL off the allowlist without fetching', async () => {
    const remote = fetcher();
    const client = await connect(await setup(remote), writer);
    const result = (await client.callTool({
      name: 'embed_resolve',
      arguments: { url: 'https://evil.example/@a/1/../../x', space: SPACE },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(remote.calls).toEqual([]);
  });

  it('needs content:write in the space named, as the HTTP route does', async () => {
    const remote = fetcher();
    const deps = await setup(remote);
    for (const principal of [reader, elsewhere]) {
      const client = await connect(deps, principal);
      const result = (await client.callTool({
        name: 'embed_resolve',
        arguments: { url: VIDEO, space: SPACE },
      })) as ToolResult;
      expect(result.isError).toBe(true);
    }
    expect(remote.calls).toEqual([]);
  });
});
