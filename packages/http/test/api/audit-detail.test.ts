import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { type Principal, SCOPES } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import type { AuditEntry } from '@commerceworker/ports';
import { RecordingEmailSender } from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';
import { makeTestWorkflowEngine } from '../workflow-engine-harness';
import { testConfig } from './config';
import { wire } from './wire';

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
const headers = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const SENTINEL = 'SENTINEL_d41d8c';
const principal: Principal = {
  spaceId: 's1',
  kind: 'admin',
  scopes: Object.values(SCOPES),
};

const field = (apiId: string, type: string, position: number, extra: object = {}) => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position,
  ...extra,
});

const seoAndFriends = [
  field('title', 'Symbol', 0, { localized: true }),
  field('hero', 'Component', 1, { fields: [field('alt', 'Symbol', 0)] }),
  field('body', 'RichText', 2),
  field('data', 'JSON', 3),
  field('seo', 'Seo', 4),
];

const fields = (over: Record<string, unknown> = {}) => ({
  title: { 'en-US': 'Hello' },
  hero: { 'en-US': { alt: 'A boat' } },
  ...over,
});

const doc = (text: string) => ({
  nodeType: 'document',
  content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: text, marks: [] }] }],
});

interface Json {
  [key: string]: unknown;
}

/** What is the same about a change whichever surface made it. */
const shape = (row: AuditEntry | undefined) => ({
  entries: row?.detail?.entries.map(({ entryId: _id, ...rest }) => rest),
  truncated: row?.detail?.truncated,
});

describe('audit row detail, over REST and MCP', () => {
  let wired: ReturnType<typeof wire>;
  let harness: ReturnType<typeof makeTestWorkflowEngine>;
  let app: ReturnType<typeof createApp>;
  let client: Client;

  const rest = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`${M}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({
      name,
      arguments: { space: 's1', environment: 'main', ...args },
    });
    const text = (result.content as { type: string; text?: string }[]).find(
      (c) => c.type === 'text',
    )?.text;
    return {
      isError: result.isError === true,
      body: JSON.parse(text?.startsWith('{') ? text : '{}') as Json,
    };
  };
  const newEntry = async (over: Record<string, unknown> = {}) => {
    const created = await rest('POST', '/entries', {
      contentTypeApiId: 'article',
      fields: fields(over),
    });
    expect(created.status).toBe(201);
    return (created.body.entry as Json).id as string;
  };
  /** The newest row for `action`, as the audit log reads it back. */
  const rowOf = async (action: string) => {
    const page = (await (
      await app.request(`/spaces/s1/audit-log?action=${encodeURIComponent(action)}`, { headers })
    ).json()) as { items: AuditEntry[] };
    return page.items[0];
  };

  beforeEach(async () => {
    wired = wire(config);
    harness = makeTestWorkflowEngine(wired.ctx, { email: new RecordingEmailSender() });
    app = createApp(
      wired.ctx,
      config,
      wired.rag,
      wired.blob,
      wired.ai,
      inMemoryEdge(),
      wired.bus,
      undefined,
      undefined,
      { workflowEngine: harness.engine, workflowNodes: { ai: wired.ai } },
    );
    expect(
      (
        await rest('POST', '/content-types', {
          apiId: 'article',
          name: 'Article',
          displayField: 'title',
          fields: seoAndFriends,
        })
      ).status,
    ).toBe(201);
    await rest('POST', '/content-types/article/published');

    const deps: McpDeps = {
      ...inMemoryEdge(),
      ctx: wired.ctx,
      ai: wired.ai,
      rag: wired.rag,
      hasher: { hash: (v: string) => createHash('sha256').update(v).digest('hex') },
      adminToken: 'admin',
      agents: new InProcessAgentRuntime(makeActivities({ ctx: wired.ctx, ai: wired.ai })),
      workflowEngine: harness.engine,
    } as McpDeps;
    const server = buildServer(deps, principal);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
  });

  it('says the same thing for the same edit on both surfaces', async () => {
    const edit = fields({
      title: { 'en-US': 'Hello', de: 'Hallo' },
      hero: { 'en-US': { alt: 'A ship' } },
      body: { 'en-US': doc('New') },
    });
    const viaRest = await newEntry();
    const viaMcp = await newEntry();
    expect((await rest('PUT', `/entries/${viaRest}`, { fields: edit })).status).toBe(200);
    expect((await tool('entries_update', { id: viaMcp, fields: edit })).isError).toBe(false);

    const restRow = await rowOf(`PUT ${ROUTE}/entries/:id`);
    const mcpRow = await rowOf('MCP entries_update');
    expect(restRow?.detail?.entries).toEqual([
      {
        entryId: viaRest,
        contentType: 'article',
        kind: 'updated',
        version: 2,
        paths: ['fields.title', 'fields.hero.alt', 'fields.body'],
        locales: ['de'],
      },
    ]);
    expect(mcpRow?.detail?.entries[0]?.entryId).toBe(viaMcp);
    expect(shape(mcpRow)).toEqual(shape(restRow));
  });

  it('names what a create made on both surfaces, which its route and arguments can’t', async () => {
    const viaRest = await newEntry();
    const made = await tool('entries_create', { contentType: 'article', fields: fields() });
    const restRow = await rowOf(`POST ${ROUTE}/entries`);
    const mcpRow = await rowOf('MCP entries_create');
    expect(restRow).toMatchObject({ targetType: 'entry', targetId: viaRest });
    expect(mcpRow).toMatchObject({
      targetType: 'entry',
      targetId: (made.body.entry as Json).id,
    });
    expect(shape(mcpRow)).toEqual(shape(restRow));
    expect(restRow?.detail?.entries[0]).toMatchObject({
      kind: 'created',
      version: 1,
      paths: ['fields.title', 'fields.hero'],
    });
  });

  it('reaches the saves a route makes on the way to something else, on both surfaces', async () => {
    const viaRest = await newEntry();
    const viaMcp = await newEntry();
    await rest('PATCH', `/entries/${viaRest}/seo`, { title: 'A title' });
    await tool('entries_set_seo', { id: viaMcp, title: 'A title' });
    const seoRest = await rowOf(`PATCH ${ROUTE}/entries/:id/seo`);
    const seoMcp = await rowOf('MCP entries_set_seo');
    expect(seoRest?.detail?.entries[0]?.paths).toEqual(['fields.seo']);
    expect(shape(seoMcp)).toEqual(shape(seoRest));

    await rest('POST', `/entries/${viaRest}/versions/1/restore`);
    await tool('entries_restore_version', { id: viaMcp, version: 1 });
    const restRestore = await rowOf(`POST ${ROUTE}/entries/:id/versions/:version/restore`);
    const mcpRestore = await rowOf('MCP entries_restore_version');
    expect(restRestore?.detail?.entries[0]).toMatchObject({ version: 3, paths: ['fields.seo'] });
    expect(shape(mcpRestore)).toEqual(shape(restRestore));
  });

  it('keeps every value out of the row, and out of the log as it is read', async () => {
    const id = await newEntry();
    const saved = await rest('PUT', `/entries/${id}`, {
      fields: fields({
        title: { 'en-US': SENTINEL, [`x-${SENTINEL}`]: SENTINEL },
        hero: { 'en-US': { alt: SENTINEL } },
        body: { 'en-US': doc(SENTINEL) },
        data: { 'en-US': { [SENTINEL]: { token: SENTINEL } } },
      }),
    });
    expect(saved.status).toBe(200);
    const viaMcp = await newEntry();
    await tool('entries_update', {
      id: viaMcp,
      fields: fields({ data: { 'en-US': { [SENTINEL]: SENTINEL } } }),
    });

    const listed = await app.request('/spaces/s1/audit-log', { headers });
    expect(await listed.text()).not.toContain(SENTINEL);
    const read = await tool('audit_log_list', {});
    expect(JSON.stringify(read.body)).not.toContain(SENTINEL);
    expect((read.body.items as AuditEntry[]).some((r) => r.detail)).toBe(true);
  });

  it('serves detail over audit_log_list as REST does, and no key on a row without it', async () => {
    const id = await newEntry();
    await rest('PUT', `/entries/${id}`, { fields: fields({ title: { 'en-US': 'New' } }) });
    await rest('POST', '/content-types', {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [field('title', 'Symbol', 0)],
    });
    const page = (await (await app.request('/spaces/s1/audit-log', { headers })).json()) as {
      items: AuditEntry[];
    };
    const read = await tool('audit_log_list', {});
    expect(read.body.items).toEqual(page.items);
    const by = (action: string) => page.items.find((r) => r.action.startsWith(action));
    expect(by('POST /spaces/:space/environments/:env/content-types')).not.toHaveProperty('detail');
    expect(by('PUT')?.detail?.entries[0]?.paths).toEqual(['fields.title']);
  });

  it('writes no row and no detail for a refused save', async () => {
    const id = await newEntry();
    const refused = await rest('PUT', `/entries/${id}`, {
      fields: fields({ nope: { 'en-US': SENTINEL } }),
    });
    expect(refused.status).toBe(422);
    const failed = await tool('entries_update', {
      id,
      fields: fields({ nope: { 'en-US': SENTINEL } }),
    });
    expect(failed.isError).toBe(true);
    const page = (await (await app.request('/spaces/s1/audit-log', { headers })).json()) as {
      items: AuditEntry[];
    };
    expect(page.items.filter((r) => r.targetId === id && r.action.includes('PUT'))).toEqual([]);
    expect(await rowOf('MCP entries_update')).toBeUndefined();
  });

  it('doesn’t carry one MCP call’s changes onto the next call’s row', async () => {
    const id = await newEntry();
    await tool('entries_update', { id, fields: fields({ title: { 'en-US': 'One' } }) });
    await tool('entries_update', { id, fields: fields({ data: { 'en-US': { a: 1 } } }) });
    const rows = await wired.ctx.store.audit.list('s1', { action: 'MCP entries_update' });
    // Rows in one millisecond have no order to rely on; the versions they made do.
    const changes = rows
      .flatMap((r) => r.detail?.entries ?? [])
      .sort((a, b) => a.version - b.version);
    expect(changes.map((c) => [c.version, c.paths])).toEqual([
      [2, ['fields.title']],
      [3, ['fields.title', 'fields.data']],
    ]);
  });

  it('keeps calls of one batch, running at once, off each other’s rows', async () => {
    const [a, b, c] = [await newEntry(), await newEntry(), await newEntry()];
    await Promise.all([
      tool('entries_update', { id: a, fields: fields({ title: { 'en-US': 'One' } }) }),
      tool('entries_get', { id: a }),
      tool('entries_update', { id: b, fields: fields({ hero: { 'en-US': { alt: 'Two' } } }) }),
      tool('entries_update', { id: c, fields: fields({ data: { 'en-US': { a: 1 } } }) }),
    ]);
    const rows = await wired.ctx.store.audit.list('s1', { action: 'MCP entries_update' });
    const byTarget = Object.fromEntries(
      rows.map((r) => [r.targetId, r.detail?.entries.map((e) => [e.entryId, e.paths])]),
    );
    expect(byTarget).toEqual({
      [a]: [[a, ['fields.title']]],
      [b]: [[b, ['fields.hero.alt']]],
      [c]: [[c, ['fields.data']]],
    });
  });

  it('puts what cancelling a run undid on the surface’s row, on both surfaces', async () => {
    const graph = {
      nodes: [
        { id: 'start', type: 'trigger.manual', label: 'Submit', position: { x: 0, y: 0 } },
        { id: 'done', type: 'control.end', label: 'Done', position: { x: 0, y: 0 } },
      ],
      edges: [{ id: 'e', source: 'start', target: 'done' }],
    };
    const startRun = async (entryId: string, workflowId: string) => {
      const scope = { spaceId: 's1', environmentId: 'main' };
      const started = await rest('POST', `/entries/${entryId}/workflow-runs`, { workflowId });
      expect(started.status).toBe(201);
      const runId = started.body.id as string;
      const saved = await rest('PUT', `/entries/${entryId}`, {
        fields: fields({ title: { 'en-US': 'From the run' } }),
      });
      const t = Date.now();
      await wired.ctx.store.workflowRuns.recordNodeRun(scope, {
        runId,
        generation: 1,
        nodeId: 'set',
        run: 1,
        nodeType: 'content.set_fields',
        status: 'succeeded',
        summary: null,
        output: {
          locale: 'en-US',
          version: (saved.body.entry as Json).currentVersion,
          prior: { title: 'Hello' },
        },
        error: null,
        startedAt: t,
        endedAt: t + 1,
        durationMs: 1,
        model: null,
        ranBy: null,
      });
      return runId;
    };
    await wired.ctx.store.workflowGraphs.publishVersion(
      { spaceId: 's1', environmentId: 'main' },
      { id: 'wf', name: 'Edit', description: '', contentTypes: ['article'], graph } as never,
      { publishedAt: new Date().toISOString() },
    );

    const viaRest = await newEntry();
    const viaMcp = await newEntry();
    const restRun = await startRun(viaRest, 'wf');
    const mcpRun = await startRun(viaMcp, 'wf');
    expect((await rest('POST', `/workflow-runs/${restRun}/cancel`, {})).status).toBe(200);
    expect((await tool('workflow_run_cancel', { runId: mcpRun })).isError).toBe(false);

    const restRow = await rowOf(`POST ${ROUTE}/workflow-runs/:id/cancel`);
    const mcpRow = await rowOf('MCP workflow_run_cancel');
    expect(restRow?.detail?.entries[0]).toMatchObject({
      entryId: viaRest,
      paths: ['fields.title'],
    });
    expect(shape(mcpRow)).toEqual(shape(restRow));
    const own = await wired.ctx.store.audit.list('s1', { action: 'workflow.run.cancelled' });
    expect(own.map((r) => r.detail?.entries[0]?.paths)).toEqual([
      ['fields.title'],
      ['fields.title'],
    ]);
  });
});
