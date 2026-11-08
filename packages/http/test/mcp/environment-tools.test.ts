import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  publishContentType,
  SYSTEM_CALLER,
  setEnvironmentAlias,
} from '@commerceworker/application';
import { type Principal, SCOPES, scopesForKind } from '@commerceworker/domain';
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
import {
  drainImportJobs,
  SNAPSHOT_ENVELOPE,
  sections,
  seedEverySection,
} from '../snapshot-round-trip';

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

describe('environment_delete over MCP', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    for (const spaceId of ['space-1', 'space-2']) {
      await createSpace(deps.ctx, { spaceId, name: spaceId, defaultLocale: 'en-US' });
      await createEnvironment(deps.ctx, spaceId, 'staging');
    }
  });

  const remaining = async (spaceId: string) =>
    (await deps.ctx.store.spaces.listEnvironments(spaceId)).map((e) => e.id);

  it('refuses a key for another space, and a key without space:admin', async () => {
    const otherSpace = await connect(deps, {
      spaceId: 'space-1',
      kind: 'cma',
      scopes: [...scopesForKind('cma')],
    });
    const cross = await otherSpace.callTool({
      name: 'environment_delete',
      arguments: { environment: 'staging', confirm: 'staging', space: 'space-2' },
    });
    expect(cross.isError).toBe(true);
    const reader = await connect(deps, {
      spaceId: 'space-1',
      kind: 'cda',
      scopes: [...scopesForKind('cda')],
    });
    const denied = await reader.callTool({
      name: 'environment_delete',
      arguments: { environment: 'staging', confirm: 'staging', space: 'space-1' },
    });
    expect(denied.isError).toBe(true);
    expect(await remaining('space-1')).toContain('staging');
    expect(await remaining('space-2')).toContain('staging');
  });

  it('deletes for a space admin who confirms, and records who did it', async () => {
    const adminOfSpace: Principal = {
      spaceId: 'space-1',
      kind: 'user',
      subject: 'usr_ada',
      scopes: [SCOPES.spaceAdmin],
    };
    const client = await connect(deps, adminOfSpace);
    const unconfirmed = await client.callTool({
      name: 'environment_delete',
      arguments: { environment: 'staging', confirm: 'main', space: 'space-1' },
    });
    expect(unconfirmed.isError).toBe(true);
    const done = await client.callTool({
      name: 'environment_delete',
      arguments: { environment: 'staging', confirm: 'staging', space: 'space-1' },
    });
    expect(done.isError).toBeFalsy();
    expect(await remaining('space-1')).not.toContain('staging');
    const audit = await deps.ctx.store.audit.list('space-1', { environmentId: 'staging' });
    expect(audit.find((a) => a.action === 'environment.deleted')?.actor).toBe('usr_ada');
  });
});

describe('the environment a tool names', () => {
  let deps: McpDeps;
  const article = {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  };
  const writer: Principal = { spaceId: 'space-1', kind: 'cma', scopes: [...scopesForKind('cma')] };
  beforeEach(async () => {
    deps = makeDeps();
    for (const spaceId of ['space-1', 'space-2']) {
      await createSpace(deps.ctx, { spaceId, name: spaceId, defaultLocale: 'en-US' });
      await createEnvironment(deps.ctx, spaceId, 'staging');
    }
  });

  it('must exist, so a typo collects nothing', async () => {
    const client = await connect(deps, writer);
    const typo = await client.callTool({
      name: 'model_create_content_type',
      arguments: { ...article, environment: 'stagign' },
    });
    expect(typo.isError).toBe(true);
    expect(JSON.stringify(typo.content)).toContain('not found');
    const scope = { spaceId: 'space-1', environmentId: 'stagign' };
    expect(await deps.ctx.store.contentTypes.list(scope)).toEqual([]);
  });

  it('resolves through an alias to its target', async () => {
    await setEnvironmentAlias(deps.ctx, 'space-1', 'live', 'staging');
    const client = await connect(deps, writer);
    const done = await client.callTool({
      name: 'model_create_content_type',
      arguments: { ...article, environment: 'live' },
    });
    expect(done.isError).toBeFalsy();
    const staging = { spaceId: 'space-1', environmentId: 'staging' };
    expect((await deps.ctx.store.contentTypes.list(staging)).map((t) => t.apiId)).toEqual([
      'article',
    ]);
  });

  it('is not revealed to a caller from another space', async () => {
    const client = await connect(deps, writer);
    const [real, missing] = await Promise.all(
      ['staging', 'nope'].map((environment) =>
        client.callTool({
          name: 'model_list_content_types',
          arguments: { space: 'space-2', environment },
        }),
      ),
    );
    expect(real?.content).toEqual(missing?.content);
  });
});

describe('environment_clone over MCP', () => {
  it('starts the clone as jobs when object storage is bound', async () => {
    const deps = { ...makeDeps(), blob: new FakeBlobStore() };
    await createSpace(deps.ctx, { spaceId: 'space-1', name: 'S', defaultLocale: 'en-US' });
    await createEnvironment(deps.ctx, 'space-1', 'copy');
    const main = { spaceId: 'space-1', environmentId: 'main' };
    await createContentType(deps.ctx, SYSTEM_CALLER, main, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
      ],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(deps.ctx, main, 'note');
    await createEntry(deps.ctx, main, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Hello' } },
    });
    const client = await connect(deps, {
      spaceId: '*',
      kind: 'admin',
      scopes: [...scopesForKind('cma')],
    });
    const res = await client.callTool({
      name: 'environment_clone',
      arguments: { space: 'space-1', targetEnvironment: 'copy' },
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content as { text: string }[])[0]?.text ?? '{}');
    expect(body).toMatchObject({ job: { action: 'import', status: 'running', totalItems: 1 } });
    expect(body.createJobId).toBeTruthy();
  });
});

describe('environment_import over MCP', () => {
  async function setup() {
    const deps = { ...makeDeps(), blob: new FakeBlobStore() };
    for (const spaceId of ['space-1', 'space-2']) {
      await createSpace(deps.ctx, { spaceId, name: spaceId, defaultLocale: 'en-US' });
      await createEnvironment(deps.ctx, spaceId, 'copy');
    }
    const main = { spaceId: 'space-1', environmentId: 'main' };
    await createContentType(deps.ctx, SYSTEM_CALLER, main, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
      ],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(deps.ctx, main, 'note');
    await createEntry(deps.ctx, main, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Hello' } },
    });
    const admin = await connect(deps, {
      spaceId: '*',
      kind: 'admin',
      scopes: [...scopesForKind('cma')],
    });
    const exported = await admin.callTool({
      name: 'environment_export',
      arguments: { space: 'space-1' },
    });
    const snapshot = JSON.parse((exported.content as { text: string }[])[0]?.text ?? '{}');
    return { deps, admin, snapshot };
  }
  const body = (res: Awaited<ReturnType<Client['callTool']>>) =>
    JSON.parse((res.content as { text: string }[])[0]?.text ?? '{}');

  it('reports on a dry run, then imports as a job', async () => {
    const { deps, admin, snapshot } = await setup();
    const dry = await admin.callTool({
      name: 'environment_import',
      arguments: { space: 'space-1', environment: 'copy', snapshot, dryRun: true },
    });
    expect(body(dry)).toMatchObject({ dryRun: true, entries: 1 });
    const copy = { spaceId: 'space-1', environmentId: 'copy' };
    expect(await deps.ctx.store.contentTypes.list(copy)).toEqual([]);

    const res = await admin.callTool({
      name: 'environment_import',
      arguments: { space: 'space-1', environment: 'copy', snapshot },
    });
    expect(res.isError).toBeFalsy();
    expect(body(res)).toMatchObject({ report: { entries: 1 }, job: { status: 'running' } });
    expect((await deps.ctx.store.contentTypes.list(copy)).map((t) => t.apiId)).toEqual(['note']);
  });

  it('round-trips every section an export writes', async () => {
    const deps = { ...makeDeps(), blob: new FakeBlobStore() };
    await createSpace(deps.ctx, { spaceId: 'space-1', name: 'S', defaultLocale: 'en-US' });
    await createEnvironment(deps.ctx, 'space-1', 'copy');
    await seedEverySection(deps.ctx, deps.blob, { spaceId: 'space-1', environmentId: 'main' });
    const admin = await connect(deps, {
      spaceId: '*',
      kind: 'admin',
      scopes: [...scopesForKind('cma')],
    });
    const exported = body(
      await admin.callTool({ name: 'environment_export', arguments: { space: 'space-1' } }),
    );
    expect(Object.keys(exported).sort()).toEqual(
      [...Object.keys(sections(exported)), ...SNAPSHOT_ENVELOPE].sort(),
    );
    const res = await admin.callTool({
      name: 'environment_import',
      arguments: { space: 'space-1', environment: 'copy', snapshot: exported },
    });
    expect(res.isError).toBeFalsy();
    await drainImportJobs(deps.ctx, deps.blob);
    const copied = body(
      await admin.callTool({
        name: 'environment_export',
        arguments: { space: 'space-1', environment: 'copy' },
      }),
    );
    expect(sections(copied)).toEqual(sections(exported));
    expect(sections(copied).assetCollections).toHaveLength(1);
  });

  it('refuses a caller who cannot manage the target space', async () => {
    const { deps, snapshot } = await setup();
    const other = await connect(deps, {
      spaceId: 'space-1',
      kind: 'cma',
      scopes: [...scopesForKind('cma')],
    });
    const res = await other.callTool({
      name: 'environment_import',
      arguments: { space: 'space-2', environment: 'copy', snapshot },
    });
    expect(res.isError).toBe(true);
    const target = { spaceId: 'space-2', environmentId: 'copy' };
    expect(await deps.ctx.store.contentTypes.list(target)).toEqual([]);
  });
});

describe('promotions over MCP', () => {
  it('requests a promotion into main, refuses the requester’s approval, and applies another’s', async () => {
    const deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: 'space-1', name: 'S', defaultLocale: 'en-US' });
    await createEnvironment(deps.ctx, 'space-1', 'staging');
    for (const environmentId of ['staging', 'main']) {
      const scope = { spaceId: 'space-1', environmentId };
      await createContentType(deps.ctx, SYSTEM_CALLER, scope, {
        apiId: 'note',
        name: 'Note',
        displayField: 'title',
        fields: [
          {
            apiId: 'title',
            name: 'Title',
            type: 'Symbol',
            localized: false,
            required: true,
            position: 0,
          },
        ],
      } as Parameters<typeof createContentType>[3]);
      await publishContentType(deps.ctx, scope, 'note');
    }
    const { entry } = await createEntry(
      deps.ctx,
      { spaceId: 'space-1', environmentId: 'staging' },
      {
        contentTypeApiId: 'note',
        fields: { title: { 'en-US': 'Hello' } },
      },
    );
    const person = (subject: string): Principal => ({
      spaceId: 'space-1',
      kind: 'user',
      subject,
      scopes: [...scopesForKind('cma')],
    });
    const ada = await connect(deps, person('ada'));
    const body = (r: Awaited<ReturnType<Client['callTool']>>) =>
      JSON.parse((r.content as { text: string }[])[0]?.text ?? '{}');
    const requested = body(
      await ada.callTool({
        name: 'promotion_request',
        arguments: { space: 'space-1', source: 'staging', target: 'main', entries: [entry.id] },
      }),
    );
    expect(requested.status).toBe('awaiting_approval');
    const own = await ada.callTool({
      name: 'promotion_approve',
      arguments: { space: 'space-1', id: requested.id },
    });
    expect(own.isError).toBe(true);
    const grace = await connect(deps, person('grace'));
    const approved = body(
      await grace.callTool({
        name: 'promotion_approve',
        arguments: { space: 'space-1', id: requested.id },
      }),
    );
    expect(approved).toMatchObject({ status: 'completed', decidedBy: 'grace' });
  });
});
