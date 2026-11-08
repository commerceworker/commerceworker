import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  addEntryToRelease,
  createContentType,
  createEntry,
  createRelease,
  createWorkflowDraft,
  publishContentType,
  publishWorkflowVersion,
  SYSTEM_CALLER,
  saveWorkflowDraft,
} from '@commerceworker/application';
import { type Principal, SCOPES, WorkflowBuilder } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import { StubAIProvider } from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';
import { testConfig } from '../api/config';
import { type InMemoryWired, wire } from '../api/wire';

/**
 * The release and workflow lists carry what a list screen needs, the same over HTTP and MCP: a
 * release's member count, and how a workflow's published version starts (and which others start
 * with it). Neither surface makes the client fetch each row again or read the draft graph.
 */

const SPACE = 's1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
});
const READER: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };
const OUTSIDER: Principal = { spaceId: 'elsewhere', kind: 'cpa', scopes: [SCOPES.previewRead] };

type Json = Record<string, unknown>;

const startsOn = (type: string) =>
  new WorkflowBuilder()
    .n('start', type, 'Start')
    .n('done', 'control.end', 'Done')
    .e('start', 'done')
    .graph();

describe('release and workflow list summaries', () => {
  let wired: InMemoryWired;
  let ctx: AppContext;
  let deps: McpDeps;
  let ids: Record<string, string>;

  beforeEach(async () => {
    // The HTTP app's own wiring (a seeded space and the dev keys), shared with the MCP server.
    wired = wire(config);
    ctx = wired.ctx;
    deps = {
      ctx,
      ai: wired.ai,
      rag: wired.rag,
      hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
      adminToken: 'admin',
      agents: new InProcessAgentRuntime(
        makeActivities({ ctx, ai: new StubAIProvider(() => ({})) }),
      ),
    };
    await createContentType(ctx, SYSTEM_CALLER, scope, {
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
    });
    await publishContentType(ctx, scope, 'article');
    const entry = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello' } },
    });
    const launch = await createRelease(ctx, scope, { title: 'Launch' });
    await addEntryToRelease(ctx, scope, launch.id, { entityId: entry.entry.id });
    const empty = await createRelease(ctx, scope, { title: 'Empty' });

    const make = async (name: string, type: string, contentTypes: string[]) =>
      (await createWorkflowDraft(ctx, scope, { name, contentTypes, graph: startsOn(type) }))
        .workflow.id;
    const review = await make('Review', 'trigger.manual', ['article']);
    const legal = await make('Legal', 'trigger.manual', []);
    const draft = await make('Draft', 'trigger.manual', ['article']);
    await publishWorkflowVersion(ctx, scope, review);
    await publishWorkflowVersion(ctx, scope, legal);
    // Legal's draft moves to "Entry published"; the published version still starts by hand.
    await saveWorkflowDraft(ctx, scope, legal, { graph: startsOn('trigger.entry_published') });
    ids = { launch: launch.id, empty: empty.id, review, legal, draft };
  });

  async function mcp(principal: Principal) {
    const server = buildServer(deps, principal);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return async (name: string) => {
      const res = (await client.callTool({ name, arguments: { space: SPACE } })) as {
        isError?: boolean;
        content?: { type: string; text?: string }[];
      };
      const text = res.content?.find((c) => c.type === 'text')?.text ?? 'null';
      return res.isError ? { error: text } : (JSON.parse(text) as unknown);
    };
  }

  async function http(path: string) {
    const app = createApp(ctx, config, wired.rag, wired.blob, wired.ai, wired.bus);
    const res = await app.request(`/spaces/${SPACE}/environments/main${path}`, {
      headers: { Authorization: 'Bearer cpa' },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Json[] }).items;
  }

  const manual = { type: 'trigger.manual', label: 'Submit for review' };

  it('lists each release with its member count, alike on both surfaces', async () => {
    const expected = [
      expect.objectContaining({ id: ids.launch, itemCount: 1 }),
      expect.objectContaining({ id: ids.empty, itemCount: 0 }),
    ];
    const overHttp = await http('/releases');
    expect(overHttp).toEqual(expect.arrayContaining(expected));
    const overMcp = await (await mcp(READER))('releases_list');
    expect(overMcp).toEqual(overHttp);
  });

  it('lists how each published workflow starts, alike on both surfaces', async () => {
    const overHttp = await http('/workflows');
    const byId = new Map(overHttp.map((w) => [w.id, w]));
    expect(byId.get(ids.review)).toMatchObject({
      publishedTrigger: manual,
      startsAlongside: [ids.legal],
    });
    // The published version decides, not the draft that now starts on "Entry published".
    expect(byId.get(ids.legal)).toMatchObject({
      publishedTrigger: manual,
      startsAlongside: [ids.review],
    });
    const legalDraft = byId.get(ids.legal)?.graph as { nodes: Json[] } | undefined;
    expect(legalDraft?.nodes[0]?.type).toBe('trigger.entry_published');
    expect(byId.get(ids.draft)).toMatchObject({ publishedTrigger: null, startsAlongside: null });

    const call = await mcp(READER);
    expect(await call('workflow_list')).toEqual(overHttp);
  });

  it('refuses a principal from another space on the MCP list', async () => {
    const call = await mcp(OUTSIDER);
    expect(await call('workflow_list')).toHaveProperty('error');
    expect(await call('releases_list')).toHaveProperty('error');
  });
});
