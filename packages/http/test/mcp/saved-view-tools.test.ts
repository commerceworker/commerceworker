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
} from '@commerceworker/application';
import { type Principal, SCOPES } from '@commerceworker/domain';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
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
const person = (
  subject: string,
  scopes: string[],
  contentGrants?: Principal['contentGrants'],
): Principal => ({
  spaceId: SPACE,
  kind: 'user',
  subject,
  scopes,
  ...(contentGrants ? { contentGrants } : {}),
});
const lead = person('lead', [SCOPES.previewRead, SCOPES.contentManage]);
const writer = person('writer', [SCOPES.previewRead]);
const nosy = person(
  'nosy',
  [SCOPES.previewRead],
  [{ contentTypeApiId: '*', actions: ['read'], deniedFields: ['salary'] }],
);

async function setup() {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('n'),
    passwords: new FakePasswordHasher(),
  };
  const blob = new FakeBlobStore();
  const deps: McpDeps = {
    ...inMemoryEdge(),
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

const field = (apiId: string, type: string, position: number) => ({
  apiId,
  name: apiId,
  type,
  position,
  localized: false,
  required: false,
});

async function seeded() {
  const { ctx, deps } = await setup();
  const scope = { spaceId: SPACE, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'staff',
    name: 'Staff',
    displayField: 'name',
    fields: [field('name', 'Symbol', 0), field('salary', 'Integer', 1)] as never,
  });
  await publishContentType(ctx, scope, 'staff');
  for (const [name, salary] of [
    ['Ana', 100],
    ['Ben', 200],
  ] as const) {
    await createEntry(ctx, scope, {
      contentTypeApiId: 'staff',
      fields: { name: { 'en-US': name }, salary: { 'en-US': salary } },
    });
  }
  return deps;
}

type View = { id: string; name: string; revision: number };
type Run = { items: { fields: Record<string, Record<string, unknown>> }[]; ignored?: string[] };

describe('saved view tools (MCP), on the HTTP routes’ use-cases', () => {
  it('creates, lists, runs, updates and deletes a view', async () => {
    const call = await connect(await seeded(), writer);
    const made = await call('views_create', {
      name: 'Top paid',
      contentType: 'staff',
      query: { order: [{ field: 'salary', direction: 'desc' }], extra: { mine: true } },
      columns: ['salary'],
    });
    expect(made.isError, made.text).toBe(false);
    const view = made.body as View;
    expect((await call('views_list', { contentType: 'staff' })).body).toMatchObject({ total: 1 });
    expect((await call('views_get', { id: view.id })).body).toMatchObject({ name: 'Top paid' });
    const run = (await call('views_run', { id: view.id })).body as Run;
    expect(run.items.map((e) => e.fields.name?.['en-US'])).toEqual(['Ben', 'Ana']);
    expect(run.ignored).toEqual(['mine']);
    const updated = await call('views_update', { id: view.id, name: 'Paid', revision: 1 });
    expect(updated.body).toMatchObject({ name: 'Paid', revision: 2 });
    const stale = await call('views_update', { id: view.id, name: 'Late', revision: 1 });
    expect(stale.isError).toBe(true);
    expect((await call('views_delete', { id: view.id })).body).toEqual({ deleted: view.id });
    expect((await call('views_list')).body).toMatchObject({ total: 0 });
  });

  it('says a type is missing, and refuses to unshare another’s view, as HTTP does', async () => {
    const deps = await seeded();
    const person = (subject: string): Principal => ({
      spaceId: SPACE,
      kind: 'user',
      subject,
      scopes: [SCOPES.previewRead, SCOPES.contentManage],
    });
    const ada = await connect(deps, person('ada@example.com'));
    const cleo = await connect(deps, person('cleo@example.com'));
    const shared = (await ada('views_create', {
      name: 'Team',
      contentType: 'staff',
      visibility: 'shared',
    })) as { body: View };
    const refused = await cleo('views_update', { id: shared.body.id, visibility: 'personal' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Only the person who created a shared view');
    expect((await ada('views_get', { id: shared.body.id })).body).toMatchObject({
      visibility: 'shared',
    });

    await createEnvironment(deps.ctx, SPACE, 'empty');
    const run = await ada('views_run', { id: shared.body.id, environment: 'empty' });
    expect(run.body).toMatchObject({ items: [], typeMissing: true });
  });

  it('treats another person’s personal view as not found', async () => {
    const deps = await seeded();
    const view = (await (await connect(deps, writer))('views_create', { name: 'Mine' }))
      .body as View;
    const other = await connect(deps, lead);
    expect((await other('views_list')).body).toMatchObject({ total: 0 });
    for (const tool of ['views_get', 'views_run', 'views_delete']) {
      const r = await other(tool, { id: view.id });
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toMatch(/not found/i);
    }
  });

  it('asks content:manage for a shared view, and runs it with the caller’s field rules', async () => {
    const deps = await seeded();
    const asWriter = await connect(deps, writer);
    const refused = await asWriter('views_create', { name: 'Team', visibility: 'shared' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('content:manage');

    const asLead = await connect(deps, lead);
    const plain = (
      await asLead('views_create', { name: 'Staff', contentType: 'staff', visibility: 'shared' })
    ).body as View;
    const bySalary = (
      await asLead('views_create', {
        name: 'By salary',
        contentType: 'staff',
        visibility: 'shared',
        query: { where: { and: [{ field: 'salary', op: 'gte', value: 0 }] } },
      })
    ).body as View;

    const asNosy = await connect(deps, nosy);
    expect(
      ((await asNosy('views_list')).body as { items: View[] }).items.map((v) => v.name),
    ).toEqual(['Staff']);
    expect((await asNosy('views_run', { id: bySalary.id })).isError).toBe(true);
    const masked = (await asNosy('views_run', { id: plain.id })).body as Run;
    expect(masked.items).toHaveLength(2);
    expect(masked.items.every((e) => e.fields.salary === undefined)).toBe(true);
  });
});
