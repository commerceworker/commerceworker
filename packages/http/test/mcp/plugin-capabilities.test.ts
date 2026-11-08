import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { type AppContext, installPlugin } from '@commerceworker/application';
import { type PluginManifest, type Principal, SCOPES } from '@commerceworker/domain';
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

/**
 * The MCP half of capability approval: the same use-case as the admin's
 * approve step, but an agent may only confirm or narrow a grant.
 */

const SPACE = 'space-1';
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

const manifest: PluginManifest = {
  id: 'com.example.seo',
  name: 'SEO',
  version: '1.0.0',
  capabilities: ['content:read', 'content:write'],
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  entrypoint: 'index.js',
};

let deps: McpDeps;
let store: InMemoryContentStore;

beforeEach(async () => {
  store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('m') };
  deps = {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => v },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
  };
  await installPlugin(ctx, new FakeBlobStore(), admin, SPACE, {
    manifest,
    bundle: '// seo',
    approvedCapabilities: ['content:read'],
  });
});

async function call(name: string, args: Record<string, unknown>) {
  const server = buildServer(deps, admin);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const res = (await client.callTool({
    name,
    arguments: { space: SPACE, ...args },
  })) as { isError?: boolean; content?: { type: string; text?: string }[] };
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  return { isError: res.isError === true, text };
}

describe('plugin_approve_capabilities', () => {
  it('confirms the current grant', async () => {
    const res = await call('plugin_approve_capabilities', {
      id: manifest.id,
      approvedCapabilities: ['content:read'],
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toMatchObject({ approvedCapabilities: ['content:read'] });
  });

  it('narrows the grant', async () => {
    const res = await call('plugin_approve_capabilities', {
      id: manifest.id,
      approvedCapabilities: [],
    });
    expect(res.isError).toBe(false);
    expect((await store.plugins.get(SPACE, manifest.id))?.approvedCapabilities).toEqual([]);
  });

  it('refuses to widen, even to something the manifest requested', async () => {
    const res = await call('plugin_approve_capabilities', {
      id: manifest.id,
      approvedCapabilities: ['content:read', 'content:write'],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/never widen/);
    expect((await store.plugins.get(SPACE, manifest.id))?.approvedCapabilities).toEqual([
      'content:read',
    ]);
  });
});
