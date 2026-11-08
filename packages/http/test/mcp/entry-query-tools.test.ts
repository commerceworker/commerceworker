import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  publishContentType,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import { type Principal, SCOPES } from '@commerceworker/domain';
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

/** entries_query: the MCP side of GET /preview/.../entries, paged with the same cursor. */
const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const READER: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };
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
    blob: new FakeBlobStore(),
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

const text = (res: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((res.content as { text: string }[])[0]?.text ?? 'null');

interface Page {
  items: { id: string; fields: { title: Record<string, string> } }[];
  nextCursor?: string;
}

describe('entries_query over MCP', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'One', defaultLocale: 'en-US' });
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
    });
    await publishContentType(deps.ctx, scope, 'note');
    for (const t of ['b', 'd', 'a', 'c', 'e']) {
      await createEntry(deps.ctx, scope, {
        contentTypeApiId: 'note',
        fields: { title: { 'en-US': t } },
      });
    }
  });

  it('returns a page and follows nextCursor to the end, in the order asked', async () => {
    const client = await connect(deps, READER);
    const order = [{ field: 'title', direction: 'asc' }];
    const titles: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const res = await client.callTool({
        name: 'entries_query',
        arguments: {
          space: SPACE,
          contentType: 'note',
          order,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        },
      });
      expect(res.isError).toBeFalsy();
      const page = text(res) as Page;
      titles.push(...page.items.map((e) => e.fields.title['en-US'] as string));
      cursor = page.nextCursor;
      calls++;
    } while (cursor);
    expect(titles).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(calls).toBe(3);
  });

  it('refuses a cursor carried over to another order', async () => {
    const client = await connect(deps, READER);
    const first = text(
      await client.callTool({
        name: 'entries_query',
        arguments: { space: SPACE, contentType: 'note', limit: 2 },
      }),
    ) as Page;
    const res = await client.callTool({
      name: 'entries_query',
      arguments: {
        space: SPACE,
        contentType: 'note',
        order: [{ field: 'title', direction: 'desc' }],
        cursor: first.nextCursor,
      },
    });
    expect(res.isError).toBe(true);
  });

  it('writes as the session’s principal and lists its own entries with sys.createdBy=me', async () => {
    const writer: Principal = {
      spaceId: SPACE,
      kind: 'user',
      subject: 'person-1',
      scopes: [SCOPES.contentWrite, SCOPES.previewRead],
    };
    const client = await connect(deps, writer);
    const created = await client.callTool({
      name: 'entries_create',
      arguments: { space: SPACE, contentType: 'note', fields: { title: { 'en-US': 'mine' } } },
    });
    expect(created.isError).toBeFalsy();
    const view = text(created) as { entry: { id: string; createdBy: string; updatedBy: string } };
    expect(view.entry).toMatchObject({ createdBy: 'person-1', updatedBy: 'person-1' });

    const page = text(
      await client.callTool({
        name: 'entries_query',
        arguments: {
          space: SPACE,
          contentType: 'note',
          filters: [{ field: 'sys.createdBy', op: 'eq', value: 'me' }],
        },
      }),
    ) as { items: { id: string; createdBy: string }[] };
    expect(page.items.map((e) => [e.id, e.createdBy])).toEqual([[view.entry.id, 'person-1']]);
    // Another caller's `me` is themselves: the five seeded entries name nobody.
    const colleague: Principal = { ...writer, subject: 'person-2' };
    const other = text(
      await (await connect(deps, colleague)).callTool({
        name: 'entries_query',
        arguments: {
          space: SPACE,
          contentType: 'note',
          filters: [{ field: 'sys.createdBy', op: 'eq', value: 'me' }],
        },
      }),
    ) as Page;
    expect(other.items).toEqual([]);
  });

  it('refuses skip rather than reading the first page again', async () => {
    const client = await connect(deps, READER);
    const res = await client.callTool({
      name: 'entries_query',
      arguments: { space: SPACE, contentType: 'note', skip: 2 },
    });
    expect(res.isError).toBe(true);
  });

  it('serves a preview key no writer ids, and refuses it a filter or order on them', async () => {
    const client = await connect(deps, READER);
    const page = text(
      await client.callTool({
        name: 'entries_query',
        arguments: { space: SPACE, contentType: 'note', limit: 1 },
      }),
    ) as { items: Record<string, unknown>[] };
    expect(page.items[0]).not.toHaveProperty('createdBy');
    expect(page.items[0]).not.toHaveProperty('updatedBy');
    const one = text(
      await client.callTool({
        name: 'entries_get',
        arguments: { space: SPACE, id: page.items[0]?.id },
      }),
    ) as Record<string, unknown>;
    expect(one).toHaveProperty('createdAt');
    expect(one).not.toHaveProperty('createdBy');
    for (const asked of [
      { filters: [{ field: 'sys.updatedBy', op: 'eq', value: 'me' }] },
      { order: [{ field: 'sys.createdBy', direction: 'asc' }] },
    ]) {
      const res = await client.callTool({
        name: 'entries_query',
        arguments: { space: SPACE, contentType: 'note', ...asked },
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('is not served to this key');
    }
  });

  it('refuses a preview key a where predicate on a writer id, however deep', async () => {
    const client = await connect(deps, READER);
    for (const where of [
      { field: 'sys.createdBy', op: 'eq', value: 'me' },
      {
        or: [
          { field: 'title', op: 'eq', value: 'a' },
          { and: [{ field: 'sys.updatedBy', op: 'exists', value: true }] },
        ],
      },
    ]) {
      const res = await client.callTool({
        name: 'entries_query',
        arguments: { space: SPACE, contentType: 'note', where },
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('is not served to this key');
    }
  });

  it('serves a preview key no writer ids on singleton_get', async () => {
    await createContentType(deps.ctx, SYSTEM_CALLER, scope, {
      apiId: 'settings',
      name: 'Settings',
      displayField: 'title',
      singleton: true,
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: false,
          position: 0,
        },
      ],
    });
    await publishContentType(deps.ctx, scope, 'settings');
    const writer: Principal = {
      spaceId: SPACE,
      kind: 'user',
      subject: 'person-1',
      scopes: [SCOPES.contentWrite, SCOPES.previewRead],
    };
    const author = await connect(deps, writer);
    const created = await author.callTool({
      name: 'entries_create',
      arguments: { space: SPACE, contentType: 'settings', fields: { title: { 'en-US': 'One' } } },
    });
    expect(created.isError).toBeFalsy();

    const read = async (client: Client) =>
      text(
        await client.callTool({
          name: 'singleton_get',
          arguments: { space: SPACE, contentType: 'settings' },
        }),
      ) as Record<string, unknown>;
    expect(await read(author)).toMatchObject({ createdBy: 'person-1', updatedBy: 'person-1' });
    const theirs = await read(await connect(deps, READER));
    expect(theirs).toMatchObject({ contentType: 'settings' });
    expect(theirs).not.toHaveProperty('createdBy');
    expect(theirs).not.toHaveProperty('updatedBy');
  });

  it('serves a preview key no writer ids in version history or the trash', async () => {
    const writer: Principal = {
      spaceId: SPACE,
      kind: 'user',
      subject: 'person-1',
      scopes: [SCOPES.contentWrite, SCOPES.previewRead],
    };
    const author = await connect(deps, writer);
    const created = text(
      await author.callTool({
        name: 'entries_create',
        arguments: { space: SPACE, contentType: 'note', fields: { title: { 'en-US': 'gone' } } },
      }),
    ) as { entry: { id: string } };
    const id = created.entry.id;
    const trashed = await author.callTool({
      name: 'entries_trash',
      arguments: { space: SPACE, id },
    });
    expect(trashed.isError).toBeFalsy();

    const reads = async (client: Client) => ({
      versions: text(
        await client.callTool({ name: 'entries_list_versions', arguments: { space: SPACE, id } }),
      ) as Record<string, unknown>[],
      trash: text(
        await client.callTool({ name: 'entries_list_trashed', arguments: { space: SPACE } }),
      ) as Record<string, unknown>[],
    });
    // The author sees who wrote each record; the preview key gets the same records without it.
    const mine = await reads(author);
    expect(mine.versions.map((v) => v.createdBy)).toContain('person-1');
    expect(mine.trash.find((e) => e.id === id)).toMatchObject({ createdBy: 'person-1' });
    const theirs = await reads(await connect(deps, READER));
    expect(theirs.versions).toHaveLength(mine.versions.length);
    for (const v of theirs.versions) expect(v).not.toHaveProperty('createdBy');
    const row = theirs.trash.find((e) => e.id === id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('createdBy');
    expect(row).not.toHaveProperty('updatedBy');
  });
});
