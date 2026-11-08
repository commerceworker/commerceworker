import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import type { AppContext } from '@commerceworker/application';
import {
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { mcpRoutes } from '../../src/mcp/routes';

/** Deps shaped like the api Worker's: everything it wires, and no `importSources`. */
function apiLikeDeps(): McpDeps {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('r'),
  };
  return {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'root-token',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
  };
}

async function connect(deps: McpDeps): Promise<Client> {
  const app = mcpRoutes(deps);
  const transport = new StreamableHTTPClientTransport(new URL('http://api.test/mcp'), {
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', 'Bearer root-token');
      return await app.fetch(new Request(url, { ...init, headers }));
    },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

const textOf = (result: unknown) =>
  ((result as { content: { type: string; text: string }[] }).content.find((c) => c.type === 'text')
    ?.text ?? '') as string;

describe('the /mcp route', () => {
  it('offers the structured import sources when the caller wires none', async () => {
    const client = await connect(apiLikeDeps());
    const result = await client.callTool({ name: 'import_sources', arguments: {} });
    expect(result.isError).toBeFalsy();
    const ids = (JSON.parse(textOf(result)) as { id: string }[]).map((s) => s.id).sort();
    expect(ids).toEqual(['csv', 'json', 'wxr']);
  });

  it("keeps the caller's own sources when it wires some", async () => {
    const deps = apiLikeDeps();
    const only = { id: 'only', name: 'Only', parse: async () => ({ rows: [] }) };
    const client = await connect({
      ...deps,
      importSources: { only } as unknown as NonNullable<McpDeps['importSources']>,
    });
    const result = await client.callTool({ name: 'import_sources', arguments: {} });
    expect((JSON.parse(textOf(result)) as { id: string }[]).map((s) => s.id)).toEqual(['only']);
  });
});
