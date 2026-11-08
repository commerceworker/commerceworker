import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { type AppContext, createSpace } from '@commerceworker/application';
import { type Principal, SCOPES, scopesForKind } from '@commerceworker/domain';
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
const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

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
    inviteOrigin: 'https://admin.example.com',
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

const payload = (result: { content?: { type: string; text?: string }[] }): unknown =>
  JSON.parse(result.content?.find((c) => c.type === 'text')?.text ?? 'null');

describe('MCP invitation tools', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'S', defaultLocale: 'en-US' });
  });

  it('creates, lists, resends and revokes, as the HTTP API does', async () => {
    const client = await connect(deps, admin);
    const issued = payload(
      await client.callTool({
        name: 'invite_create',
        arguments: { email: 'grace@example.com', grants: [{ space: SPACE, role: 'viewer' }] },
      }),
    ) as { invite: { id: string }; token: string; url: string };
    expect(issued.url).toBe(`https://admin.example.com/invite/${issued.token}`);

    const listed = await client.callTool({
      name: 'invites_list',
      arguments: { status: 'pending' },
    });
    expect(JSON.stringify(listed.content)).toContain(issued.invite.id);
    expect(JSON.stringify(listed.content)).not.toContain(issued.token);

    const resent = payload(
      await client.callTool({ name: 'invite_resend', arguments: { id: issued.invite.id } }),
    ) as { token: string };
    expect(resent.token).not.toBe(issued.token);
    const revoked = payload(
      await client.callTool({ name: 'invite_revoke', arguments: { id: issued.invite.id } }),
    ) as { status: string };
    expect(revoked.status).toBe('revoked');
    // Audited in the space it granted a role in (by the use-case: the tools name no space).
    const audit = await deps.ctx.store.audit.list(SPACE, {});
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['invite.created', 'invite.resent', 'invite.revoked']),
    );
  });

  it('refuses a space’s own admin, and a role wider than the caller’s', async () => {
    const spaceAdmin: Principal = { spaceId: SPACE, kind: 'cma', scopes: scopesForKind('cma') };
    const client = await connect(deps, spaceAdmin);
    for (const [name, args] of [
      ['invites_list', {}],
      ['invite_create', { email: 'x@example.com' }],
    ] as const) {
      expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
    }
    const narrow: Principal = {
      spaceId: '*',
      kind: 'user',
      subject: 'u',
      scopes: [SCOPES.spaceAdmin],
    };
    const res = await (await connect(deps, narrow)).callTool({
      name: 'invite_create',
      arguments: { email: 'x@example.com', grants: [{ space: SPACE, role: 'editor' }] },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/you don't hold it/);
  });

  it('reads one by id, and refuses an admin invitation from the root MCP token', async () => {
    const client = await connect(deps, admin);
    const issued = payload(
      await client.callTool({ name: 'invite_create', arguments: { email: 'g@example.com' } }),
    ) as { invite: { id: string } };
    const one = payload(
      await client.callTool({ name: 'invite_get', arguments: { id: issued.invite.id } }),
    ) as { role: string };
    expect(one.role).toBe('member');
    const rooted = await client.callTool({
      name: 'invite_create',
      arguments: { email: 'boss@example.com', role: 'admin' },
    });
    expect(rooted.isError).toBe(true);
    expect(JSON.stringify(rooted.content)).toMatch(/signed in to the admin/);
  });

  it('offers no tool that redeems a link', async () => {
    const client = await connect(deps, admin);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).filter((n) => n.includes('invite'));
    expect(names.sort()).toEqual([
      'invite_create',
      'invite_get',
      'invite_resend',
      'invite_revoke',
      'invites_list',
    ]);
  });
});
