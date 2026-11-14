import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Principal } from '@commerceworker/domain';
import { SCOPES, scopesForKind } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';
import {
  DEPLOYMENT_TOOLS,
  TOOL_SCOPES,
  toolListedFor,
  UNSCOPED_TOOLS,
} from '../../src/mcp/tool-scopes';

const TOOLS_DIR = join(import.meta.dirname, '../../src/mcp/tools');

const deps = (): McpDeps =>
  ({
    defaultScope: { spaceId: 'space-1', environmentId: 'main' },
    ctx: {
      store: new InMemoryContentStore(),
      clock: new FixedClock(new Date('2026-01-01T00:00:00Z')),
      ids: new SequenceIdGenerator(),
    },
  }) as unknown as McpDeps;

async function connect(principal: Principal) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildServer(deps(), principal).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const listed = async (principal: Principal) =>
  (await (await connect(principal)).listTools()).tools.map((tool) => tool.name);

const everyScope: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const reader: Principal = { spaceId: 'space-1', kind: 'cpa', scopes: [SCOPES.previewRead] };

/** Each tool in the source, with the scopes its own `registerTool` call names. */
function scopesInSource(): Map<string, string[]> {
  const tools = new Map<string, string[]>();
  for (const file of readdirSync(TOOLS_DIR)) {
    if (file === 'shared.ts') continue;
    const source = readFileSync(join(TOOLS_DIR, file), 'utf8');
    for (const part of source.split('server.registerTool(').slice(1)) {
      const name = /'([a-z_0-9]+)'/.exec(part)?.[1];
      if (!name) throw new Error(`A tool in ${file} has no literal name`);
      const end = part.search(/\n {2}\);\n/);
      const own = end > 0 ? part.slice(0, end) : part;
      const scopes = [...own.matchAll(/SCOPES\.([A-Za-z]+)/g)].map(
        (m) => SCOPES[m[1] as keyof typeof SCOPES],
      );
      tools.set(name, [...new Set(scopes)].sort());
    }
  }
  return tools;
}

describe('the tools a caller is shown', () => {
  it('shows every tool to a caller with every scope', async () => {
    const names = await listed(everyScope);
    expect(names.sort()).toEqual([...scopesInSource().keys()].sort());
  });

  it('shows the root token everything its scopes can use', async () => {
    const root: Principal = { spaceId: '*', kind: 'admin', scopes: [...scopesForKind('cma')] };
    const names = await listed(root);
    expect(names).toContain('model_create_content_type');
    expect(names).toContain('docs_list');
  });

  it('shows a narrower caller only what its scopes can use', async () => {
    const names = await listed(reader);
    expect(names).toContain('docs_list');
    expect(names).toContain('asset_get');
    expect(names).not.toContain('function_create');
    expect(names.length).toBeLessThan((await listed(everyScope)).length);
  });

  it('lists nothing a caller without scopes would be refused, except unscoped tools', async () => {
    const none: Principal = { spaceId: '*', kind: 'cpa', scopes: [] };
    expect((await listed(none)).sort()).toEqual([...UNSCOPED_TOOLS].sort());
  });

  it('keeps deployment tools from a caller bound to one space, still answering if called', async () => {
    expect(await listed(reader)).not.toEqual(expect.arrayContaining([...DEPLOYMENT_TOOLS]));
    for (const tool of DEPLOYMENT_TOOLS) expect(await listed(reader)).not.toContain(tool);
    expect(await listed(everyScope)).toEqual(expect.arrayContaining([...DEPLOYMENT_TOOLS]));
    const result = await (await connect(reader)).callTool({
      name: 'scheduler_status',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Deployment administrators only/);
  });

  it('keeps an unlisted tool answering with the scope it needs', async () => {
    const client = await connect(reader);
    const result = await client.callTool({
      name: 'function_create',
      arguments: { name: 'x', eventPattern: '*', url: 'https://example.com/h' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/scope/i);
  });

  it('shows a tool that needs either of two scopes to a holder of one', () => {
    expect(TOOL_SCOPES.assets_search?.length).toBeGreaterThan(1);
    for (const scope of TOOL_SCOPES.assets_search ?? []) {
      expect(toolListedFor({ ...reader, scopes: [scope] }, 'assets_search')).toBe(true);
    }
  });
});

describe('the tool scope table', () => {
  it('names exactly the scopes each handler checks', () => {
    for (const [tool, scopes] of scopesInSource()) {
      if (scopes.length === 0) expect(UNSCOPED_TOOLS, tool).toContain(tool);
      else expect([...(TOOL_SCOPES[tool] ?? [])].sort(), tool).toEqual(scopes);
    }
  });

  it('holds deployment tools to the unscoped list, where the use-case decides', () => {
    for (const tool of DEPLOYMENT_TOOLS) expect(UNSCOPED_TOOLS, tool).toContain(tool);
  });

  it('names no tool that no longer exists', () => {
    const tools = scopesInSource();
    for (const tool of [...Object.keys(TOOL_SCOPES), ...UNSCOPED_TOOLS]) {
      expect(tools.has(tool), tool).toBe(true);
    }
  });
});
