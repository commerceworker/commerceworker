import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  authenticate,
  createApiKey,
  createSpace,
  presetRoleId,
} from '@commerceworker/application';
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
const spaceAdmin: Principal = { spaceId: SPACE, kind: 'user', scopes: [SCOPES.spaceAdmin] };

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

interface Created {
  id: string;
  kind: string;
  token: string;
}

describe('API key tools over MCP', () => {
  let deps: McpDeps;
  let client: Client;
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });

  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'S', defaultLocale: 'en-US' });
    client = await connect(deps, spaceAdmin);
  });

  it('mints a key whose token is returned once, lists it without it, and revokes it', async () => {
    const created = payload(
      await call('api_key_create', { kind: 'cda', name: 'site build' }),
    ) as Created;
    expect(created.token.startsWith('cwk_cda_')).toBe(true);
    // The token works, with the kind's default scopes, in the space it was minted for.
    const principal = await authenticate(deps.ctx, hasher, created.token);
    expect(principal).toMatchObject({ spaceId: SPACE, scopes: scopesForKind('cda') });

    const listed = payload(await call('api_keys_list', {})) as {
      items: Record<string, unknown>[];
    };
    const row = listed.items.find((k) => k.id === created.id);
    expect(row).toMatchObject({ kind: 'cda', name: 'site build', revoked: false });
    // Shown once: never in a listing, and neither is its hash.
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(JSON.stringify(listed)).not.toContain(hasher.hash(created.token));

    expect(payload(await call('api_key_revoke', { id: created.id }))).toEqual({
      revoked: created.id,
    });
    await expect(authenticate(deps.ctx, hasher, created.token)).rejects.toThrow();
  });

  it('binds a key to a role, and refuses an unknown one', async () => {
    const roleId = await presetRoleId(deps.ctx, SPACE, 'editor');
    const created = payload(await call('api_key_create', { kind: 'cma', roleId })) as Created;
    expect((await authenticate(deps.ctx, hasher, created.token)).contentGrants).toBeDefined();
    const unknown = await call('api_key_create', { kind: 'cma', roleId: 'nope' });
    expect(unknown.isError).toBe(true);
  });

  it("changes a key's role by preset name or id, and unbinds it with null", async () => {
    // Another administrator, so demoting this key leaves the space one.
    await createApiKey(deps.ctx, hasher, {
      issuer: 'system',
      spaceId: SPACE,
      kind: 'cma',
      roleId: await presetRoleId(deps.ctx, SPACE, 'admin'),
    });
    const created = payload(await call('api_key_create', { kind: 'cma' })) as Created;
    const editorRole = await presetRoleId(deps.ctx, SPACE, 'editor');
    expect(payload(await call('api_key_update', { id: created.id, role: 'editor' }))).toMatchObject(
      { id: created.id, roleId: editorRole },
    );
    expect(payload(await call('api_key_update', { id: created.id, role: null }))).toMatchObject({
      id: created.id,
      roleId: null,
      scopes: scopesForKind('cma'),
    });
    await call('api_key_revoke', { id: created.id });
    expect((await call('api_key_update', { id: created.id, role: 'editor' })).isError).toBe(true);
  });

  it("refuses revoking or demoting the space's last administrator, as REST does", async () => {
    const adminRole = await presetRoleId(deps.ctx, SPACE, 'admin');
    const only = await createApiKey(deps.ctx, hasher, {
      issuer: 'system',
      spaceId: SPACE,
      kind: 'cma',
      roleId: adminRole,
    });
    const res = await call('api_key_revoke', { id: only.apiKey.id });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/administrator/i);
    const demote = await call('api_key_update', { id: only.apiKey.id, role: 'viewer' });
    expect(demote.isError).toBe(true);
    expect(
      (await deps.ctx.store.auth.list(SPACE)).find((k) => k.id === only.apiKey.id)?.roleId,
    ).toBe(adminRole);
    expect(
      (await deps.ctx.store.auth.list(SPACE)).find((k) => k.id === only.apiKey.id)?.revoked,
    ).toBe(false);
  });

  it("404s revoking another space's key", async () => {
    await createSpace(deps.ctx, { spaceId: 'space-2', name: 'T', defaultLocale: 'en-US' });
    const foreign = await createApiKey(deps.ctx, hasher, {
      issuer: 'system',
      spaceId: 'space-2',
      kind: 'cda',
    });
    const res = await call('api_key_revoke', { id: foreign.apiKey.id });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('was not found');
  });

  it('refuses a caller without space:admin, and one acting in another space', async () => {
    const editor = await connect(deps, {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [...scopesForKind('cma')].filter((s) => s !== SCOPES.spaceAdmin),
    });
    const other = await connect(deps, {
      spaceId: 'space-2',
      kind: 'user',
      scopes: [SCOPES.spaceAdmin],
    });
    const before = (await deps.ctx.store.auth.list(SPACE)).length;
    for (const c of [editor, other]) {
      for (const [name, args] of [
        ['api_keys_list', { space: SPACE }],
        ['api_key_create', { space: SPACE, kind: 'cma' }],
        ['api_key_update', { space: SPACE, id: 'any', role: 'admin' }],
        ['api_key_revoke', { space: SPACE, id: 'any' }],
      ] as const) {
        const res = await c.callTool({ name, arguments: args });
        expect(res.isError).toBe(true);
        expect(JSON.stringify(res.content)).not.toContain('cwk_');
      }
    }
    expect(await deps.ctx.store.auth.list(SPACE)).toHaveLength(before);
  });

  it('refuses a personal access token or an OAuth token minting or widening a key', async () => {
    const roleId = await presetRoleId(deps.ctx, SPACE, 'viewer');
    const key = await createApiKey(deps.ctx, hasher, {
      issuer: 'system',
      spaceId: SPACE,
      kind: 'cma',
      roleId,
    });
    for (const delegated of [
      { ...spaceAdmin, subject: 'ada@example.com', issuance: 'pat' as const },
      { ...spaceAdmin, subject: 'ada@example.com', clientId: 'app', issuance: 'oauth' as const },
    ]) {
      const agent = await connect(deps, delegated);
      const mint = await agent.callTool({ name: 'api_key_create', arguments: { kind: 'cma' } });
      expect(mint.isError).toBe(true);
      expect(JSON.stringify(mint.content)).toContain("can't mint an API key");
      // Nor through the role the key holds.
      const widened = await agent.callTool({
        name: 'role_update',
        arguments: { id: roleId, name: 'Viewer', scopes: Object.values(SCOPES) },
      });
      expect(widened.isError).toBe(true);
      expect(JSON.stringify(widened.content)).toContain("can't mint an API key or widen one");
      for (const name of ['api_key_update', 'role_preset_assign'] as const) {
        const args =
          name === 'api_key_update'
            ? { id: key.apiKey.id, role: 'admin' }
            : { keyId: key.apiKey.id, preset: 'admin' };
        expect((await agent.callTool({ name, arguments: args })).isError).toBe(true);
      }
    }
    expect(
      (await deps.ctx.store.auth.list(SPACE)).find((k) => k.id === key.apiKey.id)?.roleId,
    ).toBe(roleId);
  });

  it('never writes the token to the audit trail', async () => {
    const created = payload(await call('api_key_create', { kind: 'cpa' })) as Created;
    const entries = JSON.stringify(await deps.ctx.store.audit.list(SPACE, {}));
    expect(entries).toContain('api_key_create');
    expect(entries).not.toContain(created.token);
    // The row names the key it created.
    const rows = await deps.ctx.store.audit.list(SPACE, {});
    expect(rows.find((r) => r.action === 'MCP api_key_create')?.targetId).toBe(created.id);
  });
});
