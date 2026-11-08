import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  addEntryToRelease,
  createContentType,
  createEntry,
  createRelease,
  createSpace,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  trashEntry,
  updateEntry,
} from '@commerceworker/application';
import { type ContentTypeGrant, type Principal, SCOPES } from '@commerceworker/domain';
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
const scope = { spaceId: SPACE, environmentId: 'main' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const role = (grant: Omit<ContentTypeGrant, 'contentTypeApiId'>): Principal => ({
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.spaceAdmin],
  contentGrants: [{ contentTypeApiId: 'post', ...grant }],
});

async function setup() {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
    passwords: new FakePasswordHasher(),
  };
  const deps: McpDeps = {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob: new FakeBlobStore(),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'post',
    name: 'Post',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
      {
        apiId: 'secret',
        name: 'Secret',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 1,
      },
    ],
  });
  await publishContentType(ctx, scope, 'post');
  const entry = async (live: boolean) => {
    const { entry: e } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Post' } },
    });
    if (live) await publishEntry(ctx, scope, e.id);
    return e.id;
  };
  return { ctx, deps, entry };
}

async function connect(deps: McpDeps, principal: Principal) {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    return { isError: r.isError === true, text: r.content?.find((c) => c.type === 'text')?.text };
  };
}

describe('comparing versions over MCP, as over HTTP', () => {
  it('counts the changes a role can’t read, and says nothing else of them', async () => {
    const { ctx, deps } = await setup();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'One' }, secret: { 'en-US': 'old secret' } },
    });
    await publishEntry(ctx, scope, entry.id);
    await updateEntry(ctx, scope, entry.id, {
      title: { 'en-US': 'One' },
      secret: { 'en-US': 'new secret' },
    });
    const call = await connect(
      deps,
      role({ actions: ['read', 'write', 'publish'], deniedFields: ['secret'] }),
    );
    const { text } = await call('entries_diff_versions', {
      id: entry.id,
      from: 'published',
      to: 'draft',
    });
    expect(JSON.parse(text ?? '{}')).toMatchObject({ hiddenChanges: 1 });
    expect(text).not.toContain('secret');
  });
});

describe('finer content actions over MCP, as over HTTP', () => {
  it('a grant that withholds nothing trashes, purges and unpublishes as before', async () => {
    const { deps, entry } = await setup();
    const call = await connect(deps, role({ actions: ['read', 'write', 'publish'] }));
    const id = await entry(true);
    expect((await call('entries_unpublish', { id })).isError).toBe(false);
    expect((await call('entries_trash', { id })).isError).toBe(false);
    expect((await call('entries_purge', { id })).isError).toBe(false);
  });

  it('refuses trash and purge to a role that withholds delete', async () => {
    const { ctx, deps, entry } = await setup();
    const call = await connect(
      deps,
      role({ actions: ['read', 'write', 'publish'], deniedActions: ['delete'] }),
    );
    const id = await entry(false);
    const trashed = await call('entries_trash', { id });
    expect(trashed.isError).toBe(true);
    expect(trashed.text).toContain('content:delete:post');
    await trashEntry(ctx, scope, id);
    expect((await call('entries_purge', { id })).text).toContain('content:delete:post');
  });

  it('refuses every way down to a role that withholds unpublish', async () => {
    const { ctx, deps, entry } = await setup();
    const call = await connect(
      deps,
      role({ actions: ['read', 'write', 'publish'], deniedActions: ['unpublish'] }),
    );
    const id = await entry(true);
    for (const [tool, args] of [
      ['entries_unpublish', { id }],
      ['entries_bulk_action', { action: 'unpublish', ids: [id] }],
      ['entries_trash', { id }],
      [
        'schedule_action',
        {
          action: 'unpublish',
          entityType: 'Entry',
          entityId: id,
          scheduledFor: '2099-01-01T00:00:00.000Z',
        },
      ],
    ] as const) {
      const r = await call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toContain('content:unpublish:post');
    }
    const release = await createRelease(ctx, scope, { title: 'Takedown' });
    const added = await call('releases_add_entry', {
      releaseId: release.id,
      entryId: id,
      action: 'unpublish',
    });
    expect(added.isError).toBe(true);
    expect(added.text).toContain('content:unpublish:post');
    await addEntryToRelease(ctx, scope, release.id, { entityId: id, action: 'unpublish' });
    expect((await call('releases_publish', { id: release.id })).text).toContain(
      'content:unpublish:post',
    );
    expect((await ctx.store.entries.get(scope, id))?.entry.publishedVersion).toBe(1);
    // Publishing is still its to do.
    expect((await call('entries_bulk_action', { action: 'publish', ids: [id] })).isError).toBe(
      false,
    );
  });

  it('creates and updates a role that withholds an action, and refuses one that lists it', async () => {
    const { deps } = await setup();
    const call = await connect(deps, admin);
    const created = await call('role_create', {
      name: 'Writes, never deletes',
      scopes: [SCOPES.contentWrite],
      contentGrants: [
        { contentTypeApiId: '*', actions: ['read', 'write'], deniedActions: ['delete'] },
      ],
    });
    expect(created.isError).toBe(false);
    expect(JSON.parse(created.text ?? '{}').contentGrants[0].deniedActions).toEqual(['delete']);
    const listed = await call('role_create', {
      name: 'Lists delete',
      scopes: [SCOPES.contentWrite],
      contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'delete'] }],
    });
    expect(listed.isError).toBe(true);
  });
});
