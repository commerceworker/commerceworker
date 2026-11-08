import { createHash } from 'node:crypto';
import { createSpaceExportReader } from '@commerceworker/adapters/import-space-export';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { type AppContext, createEnvironment, createSpace } from '@commerceworker/application';
import { type Principal, SCOPES } from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
  spaceExportFixture,
} from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { toolMutates } from '../../src/mcp/audit';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'imported' };
const args = (over: Record<string, unknown> = {}) => ({
  payload: JSON.stringify(spaceExportFixture()),
  space: SPACE,
  environment: 'imported',
  ...over,
});

function makeDeps(over: Partial<McpDeps> = {}): McpDeps {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  return {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v: string) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob: new FakeBlobStore(),
    spaceExportReader: createSpaceExportReader(),
    ...over,
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

/** Whether a tool declares itself a read (`readOnlyHint`), which is what keeps it unaudited. */
async function declaresRead(client: Client, name: string): Promise<boolean> {
  const { tools } = await client.listTools();
  return tools.find((t) => t.name === name)?.annotations?.readOnlyHint === true;
}

function payload(result: { content?: { type: string; text?: string }[] }): unknown {
  return JSON.parse(result.content?.find((c) => c.type === 'text')?.text ?? 'null');
}
const text = (result: { content?: unknown }) => JSON.stringify(result.content);

const manager: Principal = { spaceId: SPACE, kind: 'cma', scopes: [SCOPES.contentManage] };
const admin: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.contentManage, SCOPES.spaceAdmin],
};

describe('space export tools over MCP', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    for (const spaceId of [SPACE, 'space-2']) {
      await createSpace(deps.ctx, { spaceId, name: spaceId, defaultLocale: 'en-US' });
      await createEnvironment(deps.ctx, spaceId, 'imported');
    }
  });

  it('analyzes with content:manage, writes nothing, and is not audited', async () => {
    const client = await connect(deps, manager);
    const result = await client.callTool({ name: 'space_export_analyze', arguments: args() });
    expect(result.isError).toBeFalsy();
    expect(payload(result as never)).toMatchObject({
      dryRun: true,
      executable: false,
      locales: { toAdd: ['de-DE', 'fr-FR'] },
      entries: { read: 11, imported: 8, invalid: 3 },
    });
    expect(
      toolMutates(
        'space_export_analyze',
        args(),
        await declaresRead(client, 'space_export_analyze'),
      ),
    ).toBe(false);
    expect(await deps.ctx.store.contentTypes.list(scope)).toEqual([]);
    expect(await deps.ctx.store.audit.list(SPACE, {})).toEqual([]);
  });

  it('lets only a space admin add locales', async () => {
    const client = await connect(deps, manager);
    const refused = await client.callTool({
      name: 'space_export_analyze',
      arguments: args({ addLocales: true }),
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('space:admin');
    const started = await client.callTool({
      name: 'space_export_import',
      arguments: args({ addLocales: true }),
    });
    expect(started.isError).toBe(true);
    expect((await deps.ctx.store.spaces.getConfig(scope))?.locales).toEqual(['en-US']);
  });

  it('starts the import as a job for a space admin, and audits it', async () => {
    const client = await connect(deps, admin);
    const result = await client.callTool({
      name: 'space_export_import',
      arguments: args({ addLocales: true }),
    });
    expect(result.isError).toBeFalsy();
    const started = payload(result as never) as {
      report: { dryRun: boolean };
      job: { action: string; totalItems: number };
      publishJobId: string;
    };
    expect(started.report.dryRun).toBe(false);
    expect(started.job).toMatchObject({ action: 'import', totalItems: 11 });
    expect(started.publishJobId).toBeTruthy();
    expect((await deps.ctx.store.contentTypes.list(scope)).map((t) => t.apiId)).toEqual([
      'author',
      'category',
      'blogPost',
      'landing_page',
    ]);
    expect(
      toolMutates('space_export_import', args(), await declaresRead(client, 'space_export_import')),
    ).toBe(true);
    const trail = await deps.ctx.store.audit.list(SPACE, {});
    expect(trail.map((r) => r.action)).toContain('MCP space_export_import');
  });

  it('refuses a key for another space', async () => {
    const client = await connect(deps, { ...admin, spaceId: 'space-2' });
    const result = await client.callTool({ name: 'space_export_analyze', arguments: args() });
    expect(result.isError).toBe(true);
  });

  it('says so when the deployment cannot stage an import', async () => {
    const bare = makeDeps({ blob: undefined });
    await createSpace(bare.ctx, { spaceId: SPACE, name: SPACE, defaultLocale: 'en-US' });
    await createEnvironment(bare.ctx, SPACE, 'imported');
    const client = await connect(bare, admin);
    const result = await client.callTool({
      name: 'space_export_import',
      arguments: args({ addLocales: true }),
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no object storage');
  });
});
