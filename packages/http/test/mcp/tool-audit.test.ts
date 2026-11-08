import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEnvironment,
  createSpace,
  publishContentType,
  SYSTEM_CALLER,
  setEnvironmentAlias,
} from '@commerceworker/application';
import { type Principal, SCOPES } from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toolMutates, toolTargetType, WRITES_WHEN } from '../../src/mcp/audit';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };

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
    hasher: { hash: (v: string) => createHash('sha256').update(v).digest('hex') },
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

function payload(result: { content?: { type: string; text?: string }[] }): unknown {
  return JSON.parse(result.content?.find((c) => c.type === 'text')?.text ?? 'null');
}

const ada: Principal = {
  spaceId: SPACE,
  kind: 'user',
  subject: 'usr_ada',
  scopes: Object.values(SCOPES),
};

describe('MCP tool audit', () => {
  let deps: McpDeps;
  let client: Client;
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const trail = () => deps.ctx.store.audit.list(SPACE, {});

  beforeEach(async () => {
    deps = makeDeps();
    const { ctx } = deps;
    await createSpace(ctx, { spaceId: SPACE, name: 'Shop', defaultLocale: 'en-US' });
    await createEnvironment(ctx, SPACE, 'staging');
    await setEnvironmentAlias(ctx, SPACE, 'prod', 'staging');
    for (const s of [scope, { spaceId: SPACE, environmentId: 'staging' }]) {
      await createContentType(ctx, SYSTEM_CALLER, s, {
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
      await publishContentType(ctx, s, 'article');
    }
    client = await connect(deps, ada);
  });

  it('records a successful write with the actor, the tool, the scope and the target', async () => {
    const created = payload(
      await call('entries_create', {
        contentType: 'article',
        fields: { title: { 'en-US': 'Hello' } },
      }),
    ) as { entry: { id: string } };
    await call('entries_update', {
      id: created.entry.id,
      fields: { title: { 'en-US': 'Hello again' } },
    });

    const rows = await trail();
    expect(rows.map((r) => r.action).sort()).toEqual(['MCP entries_create', 'MCP entries_update']);
    const update = rows.find((r) => r.action === 'MCP entries_update');
    expect(update).toMatchObject({
      spaceId: SPACE,
      environmentId: 'main',
      actor: 'usr_ada',
      targetId: created.entry.id,
      status: 200,
    });
  });

  it('names the kind of target, in REST’s words', async () => {
    const created = payload(
      await call('entries_create', {
        contentType: 'article',
        fields: { title: { 'en-US': 'Hello' } },
      }),
    ) as { entry: { id: string } };
    await call('entries_update', {
      id: created.entry.id,
      fields: { title: { 'en-US': 'Hello again' } },
    });
    const rows = await trail();
    expect(rows.find((r) => r.action === 'MCP entries_update')?.targetType).toBe('entry');
    // entries_create's id isn't in its arguments; what it saved names it, as REST's row does.
    expect(rows.find((r) => r.action === 'MCP entries_create')).toMatchObject({
      targetType: 'entry',
      targetId: created.entry.id,
    });
  });

  it('knows the kind of target of every write that names one', async () => {
    const { tools } = await client.listTools();
    const unnamed = tools
      .filter((t) => {
        const args = Object.keys(t.inputSchema.properties ?? {});
        return (
          t.annotations?.readOnlyHint !== true &&
          args.some((a) => a === 'id' || a === 'apiId' || a === 'alias')
        );
      })
      .map((t) => t.name)
      .filter((name) => !toolTargetType(name));
    expect(unnamed).toEqual([]);
  });

  it('files a call made through an alias under the environment it resolved to', async () => {
    await call('entries_create', {
      contentType: 'article',
      fields: { title: { 'en-US': 'Staged' } },
      environment: 'prod',
    });
    const rows = await deps.ctx.store.audit.list(SPACE, { environmentId: 'staging' });
    expect(rows.map((r) => r.action)).toEqual(['MCP entries_create']);
  });

  it('records a space-level write with no environment', async () => {
    await call('environment_alias_set', { alias: 'live', targetEnvironmentId: 'main' });
    const row = (await trail()).find((r) => r.action === 'MCP environment_alias_set');
    expect(row).toMatchObject({ spaceId: SPACE, targetId: 'live', actor: 'usr_ada' });
    expect(row?.environmentId).toBeUndefined();
  });

  it('writes nothing for a read', async () => {
    const created = payload(
      await call('entries_create', {
        contentType: 'article',
        fields: { title: { 'en-US': 'Read me' } },
      }),
    ) as { entry: { id: string } };
    const before = (await trail()).length;
    await call('entries_get', { id: created.entry.id });
    await call('entries_query', { contentType: 'article' });
    await call('model_list_content_types', {});
    await call('audit_log_list', {});
    expect(await trail()).toHaveLength(before);
  });

  it('writes nothing for a call that failed', async () => {
    const invalid = await call('entries_create', { contentType: 'article', fields: {} });
    expect(invalid.isError).toBe(true);
    const missing = await call('entries_update', {
      id: 'nope',
      fields: { title: { 'en-US': 'x' } },
    });
    expect(missing.isError).toBe(true);
    const reader = await connect(deps, {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [SCOPES.previewRead],
    });
    const refused = await reader.callTool({
      name: 'entries_create',
      arguments: { contentType: 'article', fields: { title: { 'en-US': 'x' } } },
    });
    expect(refused.isError).toBe(true);
    expect(await trail()).toEqual([]);
  });

  it('never fails the call when the audit write does', async () => {
    vi.spyOn(deps.ctx.store.audit, 'append').mockRejectedValue(new Error('D1 is down'));
    const res = await call('entries_create', {
      contentType: 'article',
      fields: { title: { 'en-US': 'Still saved' } },
    });
    expect(res.isError).toBeFalsy();
    expect((payload(res) as { entry: { id: string } }).entry.id).toBeTruthy();
  });

  it('audits a propose-or-apply tool only when it applies', () => {
    expect(toolMutates('entry_translate', { id: 'e1', targetLocale: 'de' }, false)).toBe(false);
    expect(toolMutates('entry_translate', { id: 'e1', apply: true }, false)).toBe(true);
    expect(toolMutates('environment_import', { dryRun: true }, false)).toBe(false);
    expect(toolMutates('environment_import', {}, false)).toBe(true);
    expect(toolMutates('entry_audit', { id: 'e1' }, false)).toBe(false);
    expect(toolMutates('entry_audit', { id: 'e1', createTasks: true }, false)).toBe(true);
    // A tool nobody classified is audited: the trail errs toward completeness.
    expect(toolMutates('some_new_tool', {}, false)).toBe(true);
  });

  it('exempts exactly the tools that declare readOnlyHint, and audits every other', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const read = tool.annotations?.readOnlyHint === true;
      // A read is exempt whatever it is called with; a write is audited by default.
      expect(toolMutates(tool.name, { apply: true, createTasks: true }, read), tool.name).toBe(
        !read,
      );
      if (!read && !(tool.name in WRITES_WHEN)) {
        expect(toolMutates(tool.name, {}, read), tool.name).toBe(true);
      }
    }
    // The reads are a real set, not an annotation nobody declares.
    const reads = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(reads).toEqual(expect.arrayContaining(['entries_get', 'docs_list', 'audit_log_list']));
    expect(reads).not.toContain('entries_create');
    // The single-asset tools: a get is a read; create, publish and unpublish are writes.
    expect(reads).toContain('asset_get');
    for (const tool of ['asset_create', 'asset_publish', 'asset_unpublish']) {
      expect(reads, tool).not.toContain(tool);
      expect(toolMutates(tool, { id: 'a1' }, false), tool).toBe(true);
    }
  });

  it('classifies only tools that exist, and never a read as propose-or-apply', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const conditional = Object.keys(WRITES_WHEN);
    expect(conditional.filter((t) => !byName.has(t))).toEqual([]);
    expect(conditional.filter((t) => byName.get(t)?.annotations?.readOnlyHint)).toEqual([]);
  });
});
