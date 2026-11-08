// Richer queries over MCP: entries_query's startsWith, between, component paths and where groups,
// and entries_field_values, the tool side of GET .../content-types/:apiId/fields/:field/values.
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
}

const titles = (res: Awaited<ReturnType<Client['callTool']>>) =>
  (text(res) as Page).items.map((e) => e.fields.title['en-US']).sort();

const def = (apiId: string, type: string, position: number, extra = {}) =>
  ({ apiId, name: apiId, type, localized: false, required: false, position, ...extra }) as never;

describe('richer queries over MCP', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'One', defaultLocale: 'en-US' });
    await createContentType(deps.ctx, SYSTEM_CALLER, scope, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: [
        def('title', 'Symbol', 0),
        def('views', 'Integer', 1),
        def('seo', 'Component', 2, { fields: [def('title', 'Symbol', 0)] }),
        def('secret', 'Symbol', 3),
        def('body', 'RichText', 4),
      ],
    });
    await publishContentType(deps.ctx, scope, 'page');
    for (const [title, views, seo] of [
      ['Apple', 10, 'Apples'],
      ['Apricot', 30, 'Jam'],
      ['Banana', 50, 'Bread'],
    ] as const) {
      await createEntry(deps.ctx, scope, {
        contentTypeApiId: 'page',
        fields: {
          title: { 'en-US': title },
          views: { 'en-US': views },
          seo: { 'en-US': { title: seo } },
          secret: { 'en-US': 's' },
        },
      });
    }
  });

  const query = (client: Client, args: Record<string, unknown>) =>
    client.callTool({
      name: 'entries_query',
      arguments: { space: SPACE, contentType: 'page', ...args },
    });

  it('startsWith, between and a component path as filters', async () => {
    const client = await connect(deps, READER);
    expect(
      titles(await query(client, { filters: [{ field: 'title', op: 'startsWith', value: 'ap' }] })),
    ).toEqual(['Apple', 'Apricot']);
    expect(
      titles(
        await query(client, { filters: [{ field: 'views', op: 'between', value: [20, 60] }] }),
      ),
    ).toEqual(['Apricot', 'Banana']);
    expect(
      titles(await query(client, { filters: [{ field: 'seo.title', op: 'eq', value: 'Jam' }] })),
    ).toEqual(['Apricot']);
  });

  it('where takes OR and AND groups, and refuses a malformed tree', async () => {
    const client = await connect(deps, READER);
    const where = {
      or: [
        { field: 'seo.title', op: 'eq', value: 'Bread' },
        {
          and: [
            { field: 'views', op: 'lt', value: 20 },
            { field: 'title', op: 'match', value: 'pp' },
          ],
        },
      ],
    };
    expect(titles(await query(client, { where }))).toEqual(['Apple', 'Banana']);
    for (const bad of [{ or: [] }, { or: [{ field: 'title', op: 'nope' }] }, 'title=Apple']) {
      expect((await query(client, { where: bad })).isError, JSON.stringify(bad)).toBe(true);
    }
  });

  it('refuses a where naming a hidden field', async () => {
    const restricted: Principal = {
      ...READER,
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read'], deniedFields: ['secret'] }],
    };
    const client = await connect(deps, restricted);
    const res = await query(client, { where: { or: [{ field: 'secret', value: 's' }] } });
    expect(res.isError).toBe(true);
  });

  it('entries_field_values lists values with counts, pages, and refuses what REST refuses', async () => {
    const client = await connect(deps, READER);
    const values = (args: Record<string, unknown>) =>
      client.callTool({
        name: 'entries_field_values',
        arguments: { space: SPACE, contentType: 'page', ...args },
      });
    const first = text(await values({ field: 'views', limit: 2 })) as {
      items: { value: number; count: number }[];
      nextCursor: string;
    };
    expect(first.items).toEqual([
      { value: 10, count: 1 },
      { value: 30, count: 1 },
    ]);
    expect(text(await values({ field: 'views', cursor: first.nextCursor }))).toEqual({
      items: [{ value: 50, count: 1 }],
    });
    expect((await values({ field: 'body' })).isError).toBe(true);
    const restricted: Principal = {
      ...READER,
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read'], deniedFields: ['secret'] }],
    };
    const limited = await connect(deps, restricted);
    const hidden = await limited.callTool({
      name: 'entries_field_values',
      arguments: { space: SPACE, contentType: 'page', field: 'secret' },
    });
    expect(hidden.isError).toBe(true);
  });

  it('answers more than four top-level component paths, and caps them inside where', async () => {
    const client = await connect(deps, READER);
    const path = { field: 'seo.title', op: 'exists', value: true };
    expect(
      titles(
        await query(client, {
          filters: [...Array(4).fill(path), { field: 'seo.title', op: 'eq', value: 'Jam' }],
        }),
      ),
    ).toEqual(['Apricot']);
    expect((await query(client, { where: { and: Array(5).fill(path) } })).isError).toBe(true);
  });

  it('keeps an empty match meaning "has a value"', async () => {
    const client = await connect(deps, READER);
    expect(
      titles(await query(client, { filters: [{ field: 'title', op: 'match', value: '' }] })),
    ).toEqual(['Apple', 'Apricot', 'Banana']);
  });

  it('refuses a 10,000-predicate where quickly, and any where past 8 KB of JSON', async () => {
    const client = await connect(deps, READER);
    const leaves = Array.from({ length: 10_000 }, () => ({ field: 'title', value: 'x' }));
    const started = Date.now();
    const huge = await query(client, { where: { or: leaves } });
    expect(huge.isError).toBe(true);
    expect(JSON.stringify(huge.content)).toMatch(/8192 characters/);
    expect(Date.now() - started).toBeLessThan(2000);
    // Under the length cap, the condition cap still holds.
    const many = await query(client, { where: { or: leaves.slice(0, 21) } });
    expect(many.isError).toBe(true);
    expect(JSON.stringify(many.content)).toMatch(/at most 20 conditions/);
  });

  it('entries_field_values refuses a Delivery key, an ungranted type and another space', async () => {
    const call = async (principal: Principal, args: Record<string, unknown> = {}) =>
      (
        await (
          await connect(deps, principal)
        ).callTool({
          name: 'entries_field_values',
          arguments: { space: SPACE, contentType: 'page', field: 'title', ...args },
        })
      ).isError;
    const delivery: Principal = { spaceId: SPACE, kind: 'cda', scopes: [SCOPES.deliveryRead] };
    const ungranted: Principal = {
      ...READER,
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read'] }],
    };
    expect(await call(delivery)).toBe(true);
    expect(await call(ungranted)).toBe(true);
    expect(await call(READER, { space: 'space-2' })).toBe(true);
    expect(await call(READER)).toBeFalsy();
  });
});
