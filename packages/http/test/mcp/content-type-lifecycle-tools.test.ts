import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { type AppContext, createSpace } from '@commerceworker/application';
import { type Principal, SCOPES } from '@commerceworker/domain';
import {
  FakeBlobStore,
  FakePasswordHasher,
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
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const reader: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };

async function setup() {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('n'),
    passwords: new FakePasswordHasher(),
  };
  const blob = new FakeBlobStore();
  const deps: McpDeps = {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob,
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  return { ctx, deps };
}

async function connect(deps: McpDeps, principal: Principal) {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? 'null';
    return {
      isError: r.isError === true,
      body: JSON.parse(text.startsWith('{') || text.startsWith('[') ? text : 'null') as never,
      text,
    };
  };
  return call;
}

const title = {
  apiId: 'title',
  name: 'Title',
  type: 'Symbol',
  position: 0,
  localized: false,
  required: false,
};

/** model_content_type_dependents, model_delete_content_type and model_clone_content_type. */
describe('content type delete and clone MCP tools', () => {
  it('clones a type, names what blocks a delete, and deletes when free or with its entries', async () => {
    const { ctx, deps } = await setup();
    const call = await connect(deps, admin);
    await call('model_create_content_type', {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [title],
    });
    const cloned = await call('model_clone_content_type', {
      apiId: 'note',
      newApiId: 'memo',
      name: 'Memo',
    });
    expect(cloned.body).toMatchObject({ apiId: 'memo', name: 'Memo', version: 1 });

    await call('entries_create', { contentType: 'note', fields: { title: { 'en-US': 'a' } } });
    const deps1 = await call('model_content_type_dependents', { apiId: 'note' });
    expect(deps1.body).toMatchObject({ entries: { live: 1, trashed: 0 }, linkedFrom: [] });
    const refused = await call('model_delete_content_type', { apiId: 'note' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('1 entry');

    expect((await call('model_delete_content_type', { apiId: 'memo' })).body).toEqual({
      deleted: true,
    });
    expect(
      await ctx.store.contentTypes.get({ spaceId: SPACE, environmentId: 'main' }, 'memo'),
    ).toBeNull();

    const started = await call('model_delete_content_type', { apiId: 'note', purgeEntries: true });
    expect(started.body).toMatchObject({ deleted: false, job: { action: 'content_type_delete' } });

    // Audited as a write; the dependents read is not.
    const audit = await ctx.store.audit.list(SPACE, { limit: 50 });
    const actions = audit.map((a) => a.action);
    expect(actions).toContain('MCP model_delete_content_type');
    expect(actions).toContain('MCP model_clone_content_type');
    expect(actions).not.toContain('MCP model_content_type_dependents');
  });

  it('refuses the tools to a key without the scopes or the role', async () => {
    const { deps } = await setup();
    const asAdmin = await connect(deps, admin);
    await asAdmin('model_create_content_type', {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [title],
    });
    const asReader = await connect(deps, reader);
    expect((await asReader('model_content_type_dependents', { apiId: 'note' })).isError).toBe(
      false,
    );
    expect((await asReader('model_delete_content_type', { apiId: 'note' })).isError).toBe(true);
    expect(
      (await asReader('model_clone_content_type', { apiId: 'note', newApiId: 'x', name: 'X' }))
        .isError,
    ).toBe(true);
    const manager: Principal = {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [SCOPES.contentManage, SCOPES.contentPublish],
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read', 'write', 'publish'] }],
    };
    const asManager = await connect(deps, manager);
    const job = await asManager('model_delete_content_type', { apiId: 'note', purgeEntries: true });
    expect(job.isError).toBe(true);
  });

  it('withholds dependents from a role restricted to other types', async () => {
    const { deps } = await setup();
    const asAdmin = await connect(deps, admin);
    for (const apiId of ['page', 'note']) {
      await asAdmin('model_create_content_type', {
        apiId,
        name: apiId,
        displayField: 'title',
        fields: [title],
      });
    }
    const pagesOnly: Principal = {
      spaceId: SPACE,
      kind: 'cpa',
      scopes: [SCOPES.previewRead],
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }],
    };
    const call = await connect(deps, pagesOnly);
    const refused = await call('model_content_type_dependents', { apiId: 'note' });
    expect(refused.isError).toBe(true);
    expect((await call('model_content_type_dependents', { apiId: 'page' })).isError).toBe(false);
  });

  it('takes content:write to purge entries with the type', async () => {
    const { ctx, deps } = await setup();
    const asAdmin = await connect(deps, admin);
    await asAdmin('model_create_content_type', {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [title],
    });
    await asAdmin('entries_create', { contentType: 'note', fields: { title: { 'en-US': 'a' } } });
    const noWrite: Principal = {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [SCOPES.contentManage, SCOPES.contentPublish, SCOPES.previewRead],
    };
    const call = await connect(deps, noWrite);
    const refused = await call('model_delete_content_type', { apiId: 'note', purgeEntries: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('content:write');
    expect(await ctx.store.bulkJobs.listJobs({ spaceId: SPACE, environmentId: 'main' })).toEqual(
      [],
    );
  });

  it('refuses a create that loses the race to its type’s delete, as a conflict', async () => {
    const { ctx, deps } = await setup();
    const call = await connect(deps, admin);
    await call('model_create_content_type', {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [title],
    });
    const guard = ctx.store.contentTypes.guard;
    ctx.store.contentTypes.guard = async (scope, apiId, expected) => {
      await ctx.store.contentTypes.delete(scope, apiId, 1);
      return guard(scope, apiId, expected);
    };
    const created = await call('entries_create', {
      contentType: 'note',
      fields: { title: { 'en-US': 'x' } },
    });
    ctx.store.contentTypes.guard = guard;
    expect(created.isError).toBe(true);
    expect(created.text).toMatch(/deleted or changed/);
  });
});
