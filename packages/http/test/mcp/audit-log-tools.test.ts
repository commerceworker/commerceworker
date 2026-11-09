import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { type AppContext, createSpace } from '@commerceworker/application';
import { type Principal, SCOPES } from '@commerceworker/domain';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import type { AuditEntry } from '@commerceworker/ports';
import {
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

function makeDeps(): McpDeps {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  return {
    ...inMemoryEdge(),
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

const text = (result: { content?: unknown }) =>
  (result.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === 'text')
    ?.text ?? 'null';

const admin: Principal = {
  spaceId: SPACE,
  kind: 'user',
  subject: 'usr_ada',
  scopes: Object.values(SCOPES),
};
const editor: Principal = { ...admin, scopes: [SCOPES.contentWrite] };

interface Page {
  items: AuditEntry[];
  nextCursor?: string;
}

describe('audit_log_list', () => {
  let deps: McpDeps;
  let client: Client;
  const list = async (args: Record<string, unknown>) =>
    JSON.parse(text(await client.callTool({ name: 'audit_log_list', arguments: args }))) as Page;

  const row = (n: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
    id: `a-${String(n).padStart(3, '0')}`,
    spaceId: SPACE,
    environmentId: 'main',
    actor: n % 2 ? 'usr_ada' : 'usr_grace',
    action: n % 2 ? 'MCP entries_update' : 'POST /releases',
    targetType: n % 2 ? 'entry' : 'release',
    targetId: `t${n % 3}`,
    status: 200,
    at: new Date(Date.UTC(2026, 0, 1 + n)).toISOString(),
    ...over,
  });

  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'Shop', defaultLocale: 'en-US' });
    for (let n = 0; n < 6; n++) await deps.ctx.store.audit.append(row(n));
    await deps.ctx.store.audit.append(row(9, { spaceId: 'space-2', actor: 'usr_ada' }));
    client = await connect(deps, admin);
  });

  it('filters as the REST route does', async () => {
    const ids = async (args: Record<string, unknown>) =>
      (await list({ space: SPACE, ...args })).items.map((e) => e.id);
    expect(await ids({ actor: 'usr_ada' })).toEqual(['a-005', 'a-003', 'a-001']);
    expect(await ids({ action: 'POST /releases' })).toEqual(['a-004', 'a-002', 'a-000']);
    expect(await ids({ targetType: 'entry', targetId: 't0' })).toEqual(['a-003']);
    expect(await ids({ from: '2026-01-02', to: '2026-01-03' })).toEqual(['a-002', 'a-001']);
    expect(await ids({ environment: 'staging' })).toEqual([]);
  });

  it('walks the log with nextCursor, in one space', async () => {
    const first = await list({ space: SPACE, limit: 4 });
    expect(first.items).toHaveLength(4);
    const next = await list({ space: SPACE, limit: 4, cursor: first.nextCursor });
    expect(next.items.map((e) => e.id)).toEqual(['a-001', 'a-000']);
    expect(next.nextCursor).toBeUndefined();
  });

  it('reports a bad date or cursor as a validation failure', async () => {
    for (const args of [{ from: 'soon' }, { cursor: 'x' }]) {
      const result = await client.callTool({
        name: 'audit_log_list',
        arguments: { space: SPACE, ...args },
      });
      expect(result.isError).toBe(true);
    }
  });

  it('stays space:admin', async () => {
    const limited = await connect(deps, editor);
    const result = await limited
      .callTool({ name: 'audit_log_list', arguments: { space: SPACE } })
      .catch((err: unknown) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain('usr_grace');
  });

  it('refuses a space:admin principal of another space', async () => {
    const outsider = await connect(deps, { ...admin, spaceId: 'space-2' });
    const result = await outsider
      .callTool({ name: 'audit_log_list', arguments: { space: SPACE } })
      .catch((err: unknown) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain('usr_grace');
  });

  it('writes nothing to the trail it reads', async () => {
    const before = (await deps.ctx.store.audit.list(SPACE, {})).length;
    await list({ space: SPACE, actor: 'usr_ada' });
    expect((await deps.ctx.store.audit.list(SPACE, {})).length).toBe(before);
  });
});
