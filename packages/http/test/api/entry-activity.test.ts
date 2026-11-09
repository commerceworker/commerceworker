import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { type Principal, SCOPES } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import type { AuditEntry } from '@commerceworker/ports';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';
import { testConfig } from './config';
import { wire } from './wire';

/**
 * An entry's activity over REST (`GET /entries/:id/activity`) and MCP (`entries_list_activity`):
 * the same page from both, the rows that saved the entry while targeting something else, the
 * audit log's permission on both, and a read that writes nothing.
 */

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US', 'de'],
    scale: 1,
  },
});

const M = '/spaces/s1/environments/main';
const ROUTE = '/spaces/:space/environments/:env';
const auth = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});
const admin: Principal = { spaceId: 's1', kind: 'admin', scopes: Object.values(SCOPES) };
const editor: Principal = {
  spaceId: 's1',
  kind: 'user',
  subject: 'usr_ed',
  scopes: [SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.previewRead],
};

interface Json {
  [key: string]: unknown;
}
interface Page {
  items: AuditEntry[];
  nextCursor?: string;
}

describe('an entry’s activity, over REST and MCP', () => {
  let wired: ReturnType<typeof wire>;
  let app: ReturnType<typeof createApp>;

  const rest = async (method: string, path: string, body?: unknown, token = 'admin') => {
    const res = await app.request(path.startsWith('/spaces') ? path : `${M}${path}`, {
      method,
      headers: auth(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
  };
  const connect = async (principal: Principal) => {
    const deps = {
      ...inMemoryEdge(),
      ctx: wired.ctx,
      ai: wired.ai,
      rag: wired.rag,
      hasher: { hash: (v: string) => createHash('sha256').update(v).digest('hex') },
      adminToken: 'admin',
      agents: new InProcessAgentRuntime(makeActivities({ ctx: wired.ctx, ai: wired.ai })),
    } as McpDeps;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer(deps, principal).connect(serverSide);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
    return async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({
        name,
        arguments: { space: 's1', environment: 'main', ...args },
      });
      const text = (result.content as { type: string; text?: string }[]).find(
        (c) => c.type === 'text',
      )?.text;
      return { isError: result.isError === true, text: text ?? '' };
    };
  };
  const newEntry = async (title = 'Hello') => {
    const created = await rest('POST', '/entries', {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': title } },
    });
    expect(created.status).toBe(201);
    return (created.body.entry as Json).id as string;
  };
  const activity = async (id: string, query = '') =>
    (await rest('GET', `/entries/${id}/activity${query}`)).body as unknown as Page;

  beforeEach(async () => {
    wired = wire(config);
    app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge(), wired.bus);
    expect(
      (
        await rest('POST', '/content-types', {
          apiId: 'article',
          name: 'Article',
          displayField: 'title',
          fields: [
            { apiId: 'title', name: 'Title', type: 'Symbol', localized: true, required: false },
          ],
        })
      ).status,
    ).toBe(201);
    await rest('POST', '/content-types/article/published');
  });

  it('lists what was done to the entry, with what each save changed', async () => {
    const id = await newEntry();
    await rest('PUT', `/entries/${id}`, { fields: { title: { 'en-US': 'Hi', de: 'Hallo' } } });
    await rest('POST', `/entries/${id}/published`);
    await newEntry('Someone else');

    const page = await activity(id);
    // The order is the audit log's (`at`, then `id`), held in the paging tests; these three can
    // share a millisecond on the wall clock, so here only what is listed is.
    const by = (action: string) => page.items.find((r) => r.action === `${action}`);

    expect(page.items).toHaveLength(3);
    expect(by(`POST ${ROUTE}/entries`)?.detail?.entries[0]).toMatchObject({ kind: 'created' });
    expect(by(`PUT ${ROUTE}/entries/:id`)?.detail?.entries).toEqual([
      expect.objectContaining({ entryId: id, paths: ['fields.title'], locales: ['de', 'en-US'] }),
    ]);
    // A publish saves nothing: no detail, which is not "nothing changed".
    expect(by(`POST ${ROUTE}/entries/:id/published`)).not.toHaveProperty('detail');
    expect(page.nextCursor).toBeUndefined();
  });

  it('includes the row that saved it while targeting another entry: a duplicate', async () => {
    const source = await newEntry();
    const made = await rest('POST', `/entries/${source}/duplicate`);
    expect(made.status).toBe(201);
    const copy = ((made.body.entry as Json | undefined)?.id ?? made.body.id) as string;
    expect(copy).toBeTruthy();

    const own = await activity(copy);
    expect(own.items).toHaveLength(1);
    expect(own.items[0]).toMatchObject({ targetType: 'entry', targetId: source });
    expect(own.items[0]?.detail?.entries[0]).toMatchObject({ entryId: copy, kind: 'created' });
    // The source's history has the duplicate too, by its target.
    expect((await activity(source)).items.map((r) => r.action)).toContain(
      `POST ${ROUTE}/entries/:id/duplicate`,
    );
  });

  it('gives the same page from the tool as from the route, and pages the same way', async () => {
    const id = await newEntry();
    for (const title of ['A', 'B', 'C']) {
      await rest('PUT', `/entries/${id}`, { fields: { title: { 'en-US': title } } });
    }
    const tool = await connect(admin);
    const first = await activity(id, '?limit=2');
    const viaTool = await tool('entries_list_activity', { id, limit: 2 });
    expect(viaTool.isError).toBe(false);
    expect(JSON.parse(viaTool.text)).toEqual(first);
    expect(first.items).toHaveLength(2);

    const next = await activity(id, `?limit=2&cursor=${first.nextCursor}`);
    const nextTool = await tool('entries_list_activity', {
      id,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(JSON.parse(nextTool.text)).toEqual(next);
    expect(next.items).toHaveLength(2);
    expect(next.nextCursor).toBeUndefined();
  });

  it('reads the environment an alias names, on both surfaces', async () => {
    const id = await newEntry();
    expect(
      (await rest('PUT', '/spaces/s1/environment-aliases/live', { targetEnvironmentId: 'main' }))
        .status,
    ).toBeLessThan(300);
    const viaAlias = (await rest('GET', `/spaces/s1/environments/live/entries/${id}/activity`))
      .body as unknown as Page;
    expect(viaAlias.items).toHaveLength(1);
    const tool = await connect(admin);
    const viaTool = await tool('entries_list_activity', { id, environment: 'live' });
    expect(JSON.parse(viaTool.text)).toEqual(viaAlias);
  });

  it('takes the audit log’s permission on both surfaces, not the entry’s', async () => {
    const id = await newEntry();
    // The preview key reads the entry, but doesn't administer the space.
    expect((await rest('GET', `/entries/${id}`, undefined, 'cpa')).status).toBe(200);
    expect((await rest('GET', `/entries/${id}/activity`, undefined, 'cpa')).status).toBe(403);
    expect((await rest('GET', '/spaces/s1/audit-log', undefined, 'cpa')).status).toBe(403);
    const tool = await connect(editor);
    const refused = await tool('entries_list_activity', { id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(SCOPES.spaceAdmin);
    expect(refused.text).not.toContain('POST');
  });

  it('refuses an administrator of another space, on both surfaces', async () => {
    const id = await newEntry();
    await rest('POST', '/spaces', { spaceId: 's2', name: 'Second', defaultLocale: 'en-US' });
    const minted = await rest('POST', '/spaces/s2/api-keys', { kind: 'cma', name: 's2 admin' });
    const token = minted.body.token as string;
    expect((await rest('GET', '/spaces/s2/audit-log', undefined, token)).status).toBe(200);
    expect((await rest('GET', `/entries/${id}/activity`, undefined, token)).status).toBe(403);
    const tool = await connect({ spaceId: 's2', kind: 'cma', scopes: Object.values(SCOPES) });
    const refused = await tool('entries_list_activity', { id });
    expect(refused.isError).toBe(true);
    expect(refused.text).not.toContain('PUT');
  });

  it('refuses an id that cannot be an entry id and an unreadable cursor, on both surfaces', async () => {
    const tool = await connect(admin);
    expect((await rest('GET', '/entries/not%20an%20id/activity')).status).toBe(422);
    expect((await tool('entries_list_activity', { id: 'not an id' })).isError).toBe(true);
    const id = await newEntry();
    expect((await rest('GET', `/entries/${id}/activity?cursor=garbage!`)).status).toBe(422);
    expect((await tool('entries_list_activity', { id, cursor: 'garbage!' })).isError).toBe(true);
  });

  it('writes nothing: reading the activity adds no audit row on either surface', async () => {
    const id = await newEntry();
    const before = (await rest('GET', '/spaces/s1/audit-log')).body as unknown as Page;
    await activity(id);
    await (await connect(admin))('entries_list_activity', { id });
    const after = (await rest('GET', '/spaces/s1/audit-log')).body as unknown as Page;
    expect(after.items.map((r) => r.id)).toEqual(before.items.map((r) => r.id));
  });
});
