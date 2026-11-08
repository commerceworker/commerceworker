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
import type { McpDeps } from '../src/mcp/deps';
import { mcpRoutes } from '../src/mcp/routes';

const ROOT_TOKEN = 'edge-mcp-root-token';
const oauth = { issuer: 'https://cms.test', resource: 'https://cms.test/mcp' };

function deps(): McpDeps {
  return {
    ctx: {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('e'),
    },
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    // Never reached for the root token; an API key would need a real digest.
    hasher: { hash: async (v: string) => v },
    adminToken: ROOT_TOKEN,
  } as unknown as McpDeps;
}

const post = (headers: Record<string, string> = {}) =>
  new Request('https://cms.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

describe('the edge MCP route', () => {
  it('rejects a missing bearer with a resource-metadata challenge', async () => {
    const res = await mcpRoutes(deps(), oauth).fetch(post());
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('resource_metadata=');
    expect(challenge).not.toMatch(/invalid/i);
  });

  it('labels a bad bearer as invalid', async () => {
    const res = await mcpRoutes(deps(), oauth).fetch(post({ authorization: 'Bearer nope' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/invalid or expired/);
  });

  it('authenticates GET before the MCP handler answers it', async () => {
    const res = await mcpRoutes(deps()).fetch(new Request('https://cms.test/mcp'));
    expect(res.status).toBe(401);
  });

  it('serves tools and skills for the root token through the shared handler', async () => {
    // Also the only check that the SDK, and preloadSchemas() at module scope,
    // load inside workerd.
    const app = mcpRoutes(deps());
    const transport = new StreamableHTTPClientTransport(new URL('https://cms.test/mcp'), {
      fetch: async (url, init) => {
        const req = new Request(url, init);
        req.headers.set('authorization', `Bearer ${ROOT_TOKEN}`);
        return app.fetch(req);
      },
    });
    const client = new Client(
      { name: 'test', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('docs_list');
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.some((t) => t.uriTemplate.startsWith('skill://'))).toBe(true);
  });
});
