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

/** The MCP half of plugin settings: the same use-cases as the HTTP routes. */

const SPACE = 'space-1';
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const editor: Principal = { spaceId: SPACE, kind: 'cma', scopes: [SCOPES.contentWrite] };

const manifest: PluginManifest = {
  id: 'com.example.seo',
  name: 'SEO',
  version: '1.0.0',
  capabilities: [],
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  entrypoint: 'index.js',
  settings: [
    { key: 'apiKey', label: 'API key', type: 'string', secret: true },
    { key: 'tone', label: 'Tone', type: 'select', options: ['plain', 'formal'] },
  ],
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
    approvedCapabilities: [],
  });
});

async function call(name: string, args: Record<string, unknown>, as: Principal = admin) {
  const server = buildServer(deps, as);
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

describe('plugin settings tools', () => {
  it('sets a secret and a value, and reads back only that the secret is set', async () => {
    const set = await call('plugin_set_settings', {
      id: manifest.id,
      values: { apiKey: 'sk_mcp', tone: 'formal' },
    });
    expect(set.isError).toBe(false);
    expect(set.text).not.toContain('sk_mcp');

    const got = await call('plugin_get_settings', { id: manifest.id });
    expect(got.isError).toBe(false);
    expect(got.text).not.toContain('sk_mcp');
    expect(JSON.parse(got.text)).toMatchObject({
      values: { tone: 'formal' },
      secretsSet: ['apiKey'],
      version: 1,
    });
  });

  it('refuses a value outside the field’s options', async () => {
    const res = await call('plugin_set_settings', { id: manifest.id, values: { tone: 'loud' } });
    expect(res.isError).toBe(true);
    expect(await store.pluginSettings.get(SPACE, manifest.id)).toBeNull();
  });

  it('refuses a stale expectedVersion', async () => {
    await call('plugin_set_settings', { id: manifest.id, values: { tone: 'plain' } });
    const res = await call('plugin_set_settings', {
      id: manifest.id,
      values: { tone: 'formal' },
      expectedVersion: 0,
    });
    expect(res.isError).toBe(true);
  });

  it('is space-admin only', async () => {
    expect((await call('plugin_get_settings', { id: manifest.id }, editor)).isError).toBe(true);
    expect(
      (await call('plugin_set_settings', { id: manifest.id, values: { tone: 'plain' } }, editor))
        .isError,
    ).toBe(true);
  });
});
