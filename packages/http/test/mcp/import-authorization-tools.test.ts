import { createHash } from 'node:crypto';
import { createSpaceExportReader } from '@commerceworker/adapters/import-space-export';
import { structuredImportSources } from '@commerceworker/adapters/import-structured';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  listPreviewEntries,
  publishContentType,
  SYSTEM_CALLER,
  startImportJob,
} from '@commerceworker/application';
import {
  type ContentTypeGrant,
  type Principal,
  rolePresetDefinition,
  SCOPES,
} from '@commerceworker/domain';
import type { ImportSource } from '@commerceworker/ports';
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
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const role = (contentGrants: readonly ContentTypeGrant[] | undefined): Principal => ({
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.contentWrite, SCOPES.contentManage, SCOPES.previewRead],
  ...(contentGrants ? { contentGrants } : {}),
});

const CSV = 'id,title,notes\nA,One,\nB,Two,secret\n';
const importArgs = (contentType: string) => ({
  source: 'csv',
  payload: CSV,
  contentTypeApiId: contentType,
  fields: { title: 'title', internalNotes: 'notes' },
  sourceOptions: { identityField: 'id' },
  space: SPACE,
  environment: 'main',
});

let deps: McpDeps;

async function call(principal: Principal, name: string, args: Record<string, unknown>) {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
  return { isError: r.isError === true, text };
}

beforeEach(async () => {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  deps = {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob: new FakeBlobStore(),
    importSources: structuredImportSources(),
    spaceExportReader: createSpaceExportReader(),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  await createEnvironment(ctx, SPACE, 'empty');
  for (const apiId of ['post', 'page']) {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId,
      name: apiId,
      displayField: 'title',
      fields: ['title', 'internalNotes'].map((id, position) => ({
        apiId: id,
        name: id,
        type: 'Symbol' as const,
        localized: false,
        required: false,
        position,
      })),
    });
    await publishContentType(ctx, scope, apiId);
  }
});

describe('importing as a role over MCP', () => {
  const postOnly = role([{ contentTypeApiId: 'post', actions: ['read', 'write'] }]);
  const noNotes = role([
    { contentTypeApiId: 'post', actions: ['read', 'write'], deniedFields: ['internalNotes'] },
  ]);

  it.each(['import_analyze', 'import_execute'])(
    'refuses a type the role cannot write at %s',
    async (tool) => {
      const result = await call(postOnly, tool, importArgs('page'));
      expect(result.isError).toBe(true);
      expect(result.text).toContain('content:write:page');
      expect(await listPreviewEntries(deps.ctx, scope, {})).toHaveLength(0);
    },
  );

  it('reports a record setting a denied field and writes the rest', async () => {
    const analyzed = await call(noNotes, 'import_analyze', importArgs('post'));
    expect(analyzed.isError).toBe(false);
    expect(JSON.parse(analyzed.text)).toMatchObject({ willCreate: 1, invalid: 1 });

    const run = await call(noNotes, 'import_execute', importArgs('post'));
    expect(JSON.parse(run.text)).toMatchObject({ created: 1, skipped: 1 });
    expect(JSON.stringify(await listPreviewEntries(deps.ctx, scope, {}))).not.toContain('secret');
  });

  it('leaves an unrestricted principal importing as before', async () => {
    const run = await call(role(undefined), 'import_execute', importArgs('page'));
    expect(JSON.parse(run.text)).toMatchObject({ created: 2, skipped: 0 });
  });
});

describe('environment-wide tools as a role', () => {
  const narrow = role([{ contentTypeApiId: 'post', actions: ['read', 'write', 'publish'] }]);
  const fieldRule = role([
    {
      contentTypeApiId: '*',
      actions: ['read', 'write', 'publish'],
      deniedFields: ['internalNotes'],
    },
  ]);
  const wide = role([{ contentTypeApiId: '*', actions: ['read', 'write', 'publish'] }]);
  const main = { space: SPACE, environment: 'main' };
  const empty = { space: SPACE, environment: 'empty' };

  const snapshot = async () =>
    JSON.parse((await call(admin, 'environment_export', main)).text) as unknown;

  it.each([
    ['limited to some types', narrow],
    ['with a field rule', fieldRule],
  ])('refuses a manager %s', async (_, principal) => {
    const calls: [string, Record<string, unknown>][] = [
      ['environment_export', main],
      ['environment_import', { ...empty, snapshot: await snapshot(), dryRun: true }],
      ['environment_clone', { ...main, targetEnvironment: 'empty', dryRun: true }],
      ['space_export_analyze', { ...empty, payload: JSON.stringify(spaceExportFixture()) }],
      ['space_export_import', { ...empty, payload: JSON.stringify(spaceExportFixture()) }],
    ];
    for (const [tool, args] of calls) {
      const result = await call(principal, tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toContain('on every content type');
    }
  });

  it('asks for publish only when the import publishes', async () => {
    const noPublish = role([{ contentTypeApiId: '*', actions: ['read', 'write'] }]);
    const args = { ...empty, snapshot: await snapshot(), dryRun: true };
    expect((await call(noPublish, 'environment_import', args)).isError).toBe(true);
    const drafts = await call(noPublish, 'environment_import', { ...args, publish: false });
    expect(drafts.isError).toBe(false);
  });

  it('lets a manager holding every type do all of it', async () => {
    expect((await call(wide, 'environment_export', main)).isError).toBe(false);
    const dryRun = await call(wide, 'environment_import', {
      ...empty,
      snapshot: await snapshot(),
      dryRun: true,
    });
    expect(dryRun.isError).toBe(false);
    const clone = await call(wide, 'environment_clone', { ...main, targetEnvironment: 'empty' });
    expect(clone.isError).toBe(false);
  });
});

describe('merge, compare and job tools as a role', () => {
  const narrow = role([{ contentTypeApiId: 'post', actions: ['read', 'write'] }]);
  const wide = role([{ contentTypeApiId: '*', actions: ['read', 'write'] }]);
  const envs = { source: 'main', target: 'empty', space: SPACE };
  const entryOf = async (contentTypeApiId: string) =>
    (
      await createEntry(deps.ctx, scope, {
        contentTypeApiId,
        fields: { title: { 'en-US': 'One' } },
      })
    ).entry.id;

  it('refuses a narrow manager merging entries, and leaves it the content model', async () => {
    const entries = [await entryOf('page')];
    const refused = await call(narrow, 'environments_merge', { ...envs, entries });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('on every content type');
    const model = await call(narrow, 'environments_merge', { ...envs, contentTypes: ['post'] });
    expect(model.isError).toBe(false);
    const merged = await call(wide, 'environments_merge', {
      ...envs,
      contentTypes: ['page'],
      entries,
    });
    expect(merged.isError).toBe(false);
  });

  it('shows a narrow role only the types it can read in a comparison', async () => {
    await entryOf('post');
    await entryOf('page');
    const { text } = await call(narrow, 'environments_compare', envs);
    const seen = JSON.parse(text) as {
      contentTypes: { apiId: string }[];
      entries: { contentTypeApiId: string }[];
    };
    expect(seen.contentTypes.map((c) => c.apiId)).toEqual(['post']);
    expect(seen.entries.map((e) => e.contentTypeApiId)).toEqual(['post']);
  });

  it('holds job reports and cancelling to the type the import wrote', async () => {
    const started = await startImportJob(
      deps.ctx,
      deps.blob as FakeBlobStore,
      admin,
      scope,
      deps.importSources?.csv as ImportSource,
      {
        payload: CSV,
        mapping: { contentTypeApiId: 'post', fields: { title: 'title' } },
        sourceOptions: { identityField: 'id' },
      },
    );
    const writer = (contentTypeApiId: string) => ({
      ...role([{ contentTypeApiId, actions: ['read', 'write'] as const }]),
      scopes: [SCOPES.contentPublish],
    });
    const args = { id: started.job.id, space: SPACE, environment: 'main' };
    expect((await call(writer('page'), 'bulk_job_report', args)).isError).toBe(true);
    expect((await call(writer('page'), 'bulk_job_cancel', args)).isError).toBe(true);
    expect((await call(writer('post'), 'bulk_job_report', args)).isError).toBe(false);
    expect((await call(writer('post'), 'bulk_job_cancel', args)).isError).toBe(false);
  });

  it('lets an Administrator cancel a clone', async () => {
    const preset = rolePresetDefinition('admin');
    const administrator: Principal = {
      spaceId: SPACE,
      kind: 'cma',
      scopes: preset.scopes,
      contentGrants: preset.contentGrants,
    };
    const { text } = await call(administrator, 'environment_clone', {
      space: SPACE,
      environment: 'main',
      targetEnvironment: 'empty',
    });
    const { job } = JSON.parse(text) as { job: { id: string } };
    const args = { id: job.id, space: SPACE, environment: 'empty' };
    expect((await call(narrow, 'bulk_job_cancel', args)).isError).toBe(true);
    expect((await call(administrator, 'bulk_job_cancel', args)).isError).toBe(false);
  });
});
