import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import type { AppContext } from '@commerceworker/application';
import type { Principal } from '@commerceworker/domain';
import { SCOPES } from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import {
  Client,
  StreamableHTTPClientTransport,
  type VersionNegotiationMode,
} from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { describe, expect, it } from 'vitest';
import { buildSource } from '../../scripts/generate-skills';
import type { McpDeps } from '../../src/mcp/deps';
import { authInfoFor, createHandler } from '../../src/mcp/http';
import { loadSkillCatalog } from '../../src/mcp/skills';

function makeDeps(): McpDeps {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('h'),
  };
  return {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
  };
}

const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const reader: Principal = { spaceId: 'space-1', kind: 'cda', scopes: [SCOPES.deliveryRead] };

/** A client whose HTTP requests go straight to the shared handler, authenticated as `principal`. */
async function connect(principal: Principal, mode: VersionNegotiationMode): Promise<Client> {
  const handler = createHandler(makeDeps());
  const transport = new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
    fetch: (url, init) =>
      handler.fetch(new Request(url, init), { authInfo: authInfoFor(principal, 'token') }),
  });
  const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return client;
}

describe.each(['legacy', 'auto'] as const)('MCP over HTTP (%s negotiation)', (mode) => {
  it('lists and calls tools', async () => {
    const client = await connect(admin, mode);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('docs_list');
    const result = await client.callTool({ name: 'docs_list', arguments: {} });
    expect(result.isError).toBeFalsy();
  });

  it('publishes the skills catalog, and every file verifies', async () => {
    const skills = new SkillsClient(await connect(admin, mode));
    expect(skills.supported).toBe(true);
    const { skills: listed } = await skills.list();
    expect(listed.map((s) => s.frontmatter.name).sort()).toEqual([
      'author-and-publish',
      'import-content',
      'model-content',
    ]);
    for (const skill of listed) {
      expect(skill.uri).toMatch(/^skill:\/\/commerceworker\//);
      const file = await skills.read(skill);
      expect(file.verified).toBe(true);
    }
  });
});

describe('the shared handler', () => {
  it('refuses a request that skipped authentication, without serving it', async () => {
    const res = await createHandler(makeDeps()).fetch(
      new Request('http://mcp.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain('docs_list');
  });

  it.each(['legacy', 'auto'] as const)(
    'serves identical tool schemas to every principal (%s)',
    async (mode) => {
      // Schemas are cached per process; a principal-dependent schema would leak
      // between callers. Who asks decides which tools are listed, never their shape.
      const a = await (await connect(admin, mode)).listTools();
      const b = await (await connect(reader, mode)).listTools();
      const byName = new Map(a.tools.map((tool) => [tool.name, tool]));
      expect(b.tools.length).toBeGreaterThan(0);
      for (const tool of b.tools) expect(tool).toEqual(byName.get(tool.name));
    },
  );

  it.each(['legacy', 'auto'] as const)(
    'lists only the tools a caller can use (%s)',
    async (mode) => {
      const all = (await (await connect(admin, mode)).listTools()).tools.map((t) => t.name);
      const some = (await (await connect(reader, mode)).listTools()).tools.map((t) => t.name);
      expect(all).toContain('function_create');
      expect(some).not.toContain('function_create');
      expect(some).toContain('docs_list');
      expect(some.length).toBeLessThan(all.length);
    },
  );

  it('still enforces RBAC per caller with shared schemas', async () => {
    const client = await connect(reader, 'legacy');
    const result = await client.callTool({
      name: 'function_create',
      arguments: { name: 'x', eventPattern: '*', url: 'https://example.com/h' },
    });
    expect(result.isError).toBe(true);
    // The scope guard, not some later failure, must be what refused it.
    expect(JSON.stringify(result.content)).toMatch(/scope/i);
  });

  it.each(['legacy', 'auto'] as const)(
    'accepts a body above the SDK default 4 MiB, for import payloads (%s)',
    async (mode) => {
      const client = await connect(admin, mode);
      const result = await client.callTool({
        name: 'docs_list',
        arguments: { padding: 'x'.repeat(5 * 1024 * 1024) },
      });
      expect(result.isError).toBeFalsy();
    },
  );

  it('refuses a body over 32 MiB with 413 before building a server', async () => {
    const res = await createHandler(makeDeps()).fetch(
      new Request('http://mcp.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: 'x'.repeat(33 * 1024 * 1024),
      }),
      { authInfo: authInfoFor(admin, 'token') },
    );
    expect(res.status).toBe(413);
  });
});

describe('the skill catalog', () => {
  it('is loaded once and shared', () => {
    expect(loadSkillCatalog()).toBe(loadSkillCatalog());
  });
});

describe('embedded skills', () => {
  it('match skills/ on disk', () => {
    // A stale embed would publish skills that disagree with their source.
    // Run `pnpm generate` (turbo runs it before `test`) to fix.
    const generated = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'src',
      'mcp',
      'skills.generated.ts',
    );
    expect(readFileSync(generated, 'utf8')).toBe(buildSource());
  });
});
