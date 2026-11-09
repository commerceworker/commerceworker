import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createSpace,
  principalFromPreviewToken,
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
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const TEMPLATE = 'https://site.example/blog/{field:slug}?entry={id}&token={token}';
const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };

async function connect(
  principal: Principal = admin,
  origin: string | null = 'https://admin.example',
) {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('g'),
    passwords: new FakePasswordHasher(),
  };
  const deps: McpDeps = {
    ...inMemoryEdge(),
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher,
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob: new FakeBlobStore(),
    ...(origin ? { inviteOrigin: origin } : {}),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  const connectAs = async (p: Principal) => {
    const server = buildServer(deps, p);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
        isError?: boolean;
        content?: { type: string; text?: string }[];
      };
      const text = r.content?.find((c) => c.type === 'text')?.text ?? 'null';
      return { isError: r.isError === true, text };
    };
  };
  return { call: await connectAs(principal), connectAs, ctx };
}

const post = {
  apiId: 'post',
  name: 'Post',
  displayField: 'title',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: false,
      position: 0,
    },
    { apiId: 'slug', name: 'Slug', type: 'Slug', localized: false, required: false, position: 1 },
  ],
};

describe('content type preview URL template through MCP', () => {
  it('stores, reads back and clears the template, as the route does', async () => {
    const { call } = await connect();
    const created = await call('model_create_content_type', {
      ...post,
      preview: { urlTemplate: TEMPLATE },
    });
    expect(created.isError, created.text).toBe(false);
    const read = async () =>
      JSON.parse((await call('model_get_content_type', { apiId: 'post' })).text) as Record<
        string,
        unknown
      >;
    expect((await read()).preview).toEqual({ urlTemplate: TEMPLATE });
    await call('model_create_content_type', { ...post, preview: null });
    expect(await read()).not.toHaveProperty('preview');
  });

  it('refuses a template the domain refuses', async () => {
    const { call } = await connect();
    const res = await call('model_create_content_type', {
      ...post,
      preview: { urlTemplate: 'http://site.example/?token={token}' },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('preview.urlTemplate');
  });

  it('mints a preview link whose frontend URL is the filled template', async () => {
    const { call, ctx } = await connect();
    await call('model_create_content_type', { ...post, preview: { urlTemplate: TEMPLATE } });
    const created = JSON.parse(
      (
        await call('entries_create', {
          contentType: 'post',
          fields: { title: { 'en-US': 'Hello' }, slug: { 'en-US': 'hello-world' } },
        })
      ).text,
    ) as { entry: { id: string } };
    const id = created.entry.id;
    const res = await call('entries_preview_link', { id });
    expect(res.isError, res.text).toBe(false);
    const link = JSON.parse(res.text) as { url: string; frontendUrl: string; token: string };
    expect(link.url).toBe(
      `https://admin.example/preview/${SPACE}/main/entries/${id}?preview_token=${link.token}`,
    );
    expect(link.frontendUrl).toBe(
      `https://site.example/blog/hello-world?entry=${id}&token=${link.token}`,
    );
    const scope = { spaceId: SPACE, environmentId: 'main' };
    expect(await principalFromPreviewToken(ctx, hasher, scope, id, link.token)).not.toBeNull();
  });

  it('refuses a caller without content:write', async () => {
    const { call, connectAs } = await connect();
    await call('model_create_content_type', post);
    const created = JSON.parse(
      (
        await call('entries_create', {
          contentType: 'post',
          fields: { title: { 'en-US': 'Hello' } },
        })
      ).text,
    ) as { entry: { id: string } };
    const reader = await connectAs({
      spaceId: SPACE,
      kind: 'cpa',
      scopes: [SCOPES.previewRead],
    });
    const res = await reader('entries_preview_link', { id: created.entry.id });
    expect(res.isError).toBe(true);
  });

  it('needs read on the type to point its preview links somewhere, as the route does', async () => {
    const { call, connectAs } = await connect();
    const modeller = await connectAs({
      spaceId: SPACE,
      kind: 'cma',
      scopes: [SCOPES.contentManage, SCOPES.previewRead],
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read', 'write'] }],
    });
    const preview = { urlTemplate: TEMPLATE };
    const refused = await modeller('model_create_content_type', { ...post, preview });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('content:read:post');
    expect((await modeller('model_create_content_type', post)).isError).toBe(false);
    expect((await call('model_create_content_type', { ...post, preview })).isError).toBe(false);
    const moved = await modeller('model_create_content_type', {
      ...post,
      preview: { urlTemplate: 'https://elsewhere.example/p?token={token}' },
    });
    expect(moved.isError).toBe(true);
    // Unchanged or left out: allowed.
    const same = await modeller('model_create_content_type', { ...post, name: 'Posts', preview });
    expect(same.isError, same.text).toBe(false);
    expect((await modeller('model_create_content_type', { ...post, name: 'P' })).isError).toBe(
      false,
    );
    const clone = await modeller('model_clone_content_type', {
      apiId: 'post',
      newApiId: 'story',
      name: 'Story',
    });
    expect(clone.isError).toBe(true);
  });

  it('refuses an empty locale at the schema, as the route does', async () => {
    const { call } = await connect();
    await call('model_create_content_type', post);
    const created = JSON.parse(
      (await call('entries_create', { contentType: 'post', fields: { title: { 'en-US': 'Hi' } } }))
        .text,
    ) as { entry: { id: string } };
    const res = await call('entries_preview_link', { id: created.entry.id, locale: '' });
    expect(res.isError).toBe(true);
    expect(res.text).not.toContain('Unknown locale');
  });

  it('returns the Preview API path, named as one, when the deployment has no public origin', async () => {
    const { call } = await connect(admin, null);
    await call('model_create_content_type', post);
    const created = JSON.parse(
      (await call('entries_create', { contentType: 'post', fields: { title: { 'en-US': 'Hi' } } }))
        .text,
    ) as { entry: { id: string } };
    const res = await call('entries_preview_link', { id: created.entry.id });
    const link = JSON.parse(res.text) as Record<string, string>;
    expect(link).not.toHaveProperty('url');
    expect(link.previewPath).toBe(
      `/preview/${SPACE}/main/entries/${created.entry.id}?preview_token=${link.token}`,
    );
  });

  it('makes every save name its caller: a request handler can’t leave its principal out', async () => {
    const { ctx } = await connect();
    const scope = { spaceId: SPACE, environmentId: 'main' };
    const draft = post as never;
    // @ts-expect-error: the caller is required, a principal or SYSTEM_CALLER; there is no default
    await expect(createContentType(ctx, scope, draft)).rejects.toThrow();
    // @ts-expect-error: and nothing but the marker stands in for a principal
    await expect(createContentType(ctx, { system: true }, scope, draft)).rejects.toThrow(
      'principal or the system caller',
    );
    expect((await createContentType(ctx, SYSTEM_CALLER, scope, draft)).apiId).toBe('post');
  });
});
