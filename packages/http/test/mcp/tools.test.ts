import { createHash } from 'node:crypto';
import { structuredImportSources } from '@commerceworker/adapters/import-structured';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  publishContentType,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { Principal } from '@commerceworker/domain';
import { SCOPES } from '@commerceworker/domain';
import {
  FakeVideoHost,
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

// Stub AI returns schema-shaped values so generate/canvas tools work offline.
function stubAI() {
  return new StubAIProvider((req) => {
    const props =
      (req.outputSchema as { properties?: Record<string, { type?: string }> })?.properties ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(props)) {
      out[key] = def.type === 'integer' || def.type === 'number' ? 1 : `v-${key}`;
    }
    return out;
  });
}

function makeDeps(): McpDeps {
  const store = new InMemoryContentStore();
  const ctx: AppContext = {
    store,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  return {
    ctx,
    ai: stubAI(),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
  };
}

const adminPrincipal: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

/** Connects a Client to a freshly built server for the given principal. */
async function connect(deps: McpDeps, principal: Principal): Promise<Client> {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Parses the JSON payload a tool returns via its text content. */
function payload(result: { content?: { type: string; text?: string }[] }): unknown {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? 'null';
  return JSON.parse(text);
}

async function seed(deps: McpDeps) {
  const { ctx } = deps;
  await createSpace(ctx, { spaceId: SPACE, name: 'Shop', defaultLocale: 'en-US' });
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
}

describe('MCP tools (end-to-end over the in-memory transport)', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await seed(deps);
  });

  it('lists content types', async () => {
    const client = await connect(deps, adminPrincipal);
    const res = await client.callTool({ name: 'model_list_content_types', arguments: {} });
    const types = payload(res) as { apiId: string }[];
    expect(types.map((t) => t.apiId)).toContain('article');
  });

  it('counts entries per content type, only for types the caller can read', async () => {
    const { ctx } = deps;
    await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Counted' } },
    });
    type Counts = { contentType: string; total: number; draft: number }[];
    const admin = await connect(deps, adminPrincipal);
    const counts = payload(
      await admin.callTool({ name: 'model_entry_counts', arguments: {} }),
    ) as Counts;
    expect(counts.find((c) => c.contentType === 'article')).toMatchObject({ total: 1, draft: 1 });

    const elsewhere: Principal = {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [SCOPES.previewRead],
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }],
    };
    const scoped = await connect(deps, elsewhere);
    expect(payload(await scoped.callTool({ name: 'model_entry_counts', arguments: {} }))).toEqual(
      [],
    );
  });

  it('refuses entry counts for another space, and for a delivery-only key', async () => {
    const { ctx } = deps;
    const other = { spaceId: 'space-2', environmentId: 'main' };
    await createSpace(ctx, { spaceId: 'space-2', name: 'Other', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, other, {
      apiId: 'secret',
      name: 'Secret',
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
    await publishContentType(ctx, other, 'secret');
    await createEntry(ctx, other, {
      contentTypeApiId: 'secret',
      fields: { title: { 'en-US': 'Hidden' } },
    });

    // preview:read in space-1 names space-2 in the arguments: refused, nothing disclosed.
    const reader = await connect(deps, {
      spaceId: SPACE,
      kind: 'cma',
      scopes: [SCOPES.previewRead],
    });
    const cross = await reader.callTool({
      name: 'model_entry_counts',
      arguments: { space: 'space-2' },
    });
    expect(cross.isError).toBe(true);
    expect(JSON.stringify(cross)).not.toContain('secret');
    // The same key still counts its own space.
    expect((await reader.callTool({ name: 'model_entry_counts', arguments: {} })).isError).toBe(
      undefined,
    );

    // A delivery-only key lacks preview:read even in its own space.
    const cda = await connect(deps, { spaceId: SPACE, kind: 'cda', scopes: [SCOPES.deliveryRead] });
    expect((await cda.callTool({ name: 'model_entry_counts', arguments: {} })).isError).toBe(true);
  });

  it('round-trips a function through create → list → delete', async () => {
    const client = await connect(deps, adminPrincipal);
    const created = payload(
      await client.callTool({
        name: 'function_create',
        arguments: { name: 'reindex', eventPattern: 'entry.*', url: 'https://example.com/h' },
      }),
    ) as { id: string };
    const listed = payload(await client.callTool({ name: 'functions_list', arguments: {} })) as {
      id: string;
    }[];
    expect(listed.map((f) => f.id)).toContain(created.id);

    await client.callTool({ name: 'function_delete', arguments: { id: created.id } });
    const after = payload(await client.callTool({ name: 'functions_list', arguments: {} })) as {
      id: string;
    }[];
    expect(after.map((f) => f.id)).not.toContain(created.id);
  });

  it('registers a UI extension', async () => {
    const client = await connect(deps, adminPrincipal);
    const created = payload(
      await client.callTool({
        name: 'app_extension_create',
        arguments: { name: 'widget', target: 'sidebar', entryUrl: 'https://example.com/w' },
      }),
    ) as { id: string; target: string };
    expect(created.target).toBe('sidebar');
    const listed = payload(
      await client.callTool({ name: 'app_extensions_list', arguments: {} }),
    ) as { id: string }[];
    expect(listed.map((a) => a.id)).toContain(created.id);
  });

  it('maps prose into structured fields (entry_from_canvas)', async () => {
    const client = await connect(deps, adminPrincipal);
    const res = payload(
      await client.callTool({
        name: 'entry_from_canvas',
        arguments: { contentType: 'article', prose: 'A short story about a title.' },
      }),
    ) as { fields: Record<string, Record<string, unknown>> };
    expect(res.fields.title?.['en-US']).toBe('v-title');
  });

  it('enforces RBAC: a delivery-only principal cannot create a function', async () => {
    const reader: Principal = { spaceId: SPACE, kind: 'cda', scopes: [SCOPES.deliveryRead] };
    const client = await connect(deps, reader);
    const res = await client.callTool({
      name: 'function_create',
      arguments: { name: 'x', eventPattern: '*', url: 'https://example.com/h' },
    });
    // The authorize() guard throws; the SDK surfaces it as an error result.
    expect(res.isError).toBe(true);
  });
});

describe('documentation tools', () => {
  let deps: McpDeps;
  /** A delivery-only key: the least-privileged principal the server accepts. */
  const cda: Principal = { spaceId: SPACE, kind: 'cda', scopes: [SCOPES.deliveryRead] };

  beforeEach(async () => {
    deps = makeDeps();
    await seed(deps);
  });

  it('lists pages with headings', async () => {
    const client = await connect(deps, adminPrincipal);
    const pages = payload(await client.callTool({ name: 'docs_list', arguments: {} })) as {
      path: string;
      headings: unknown[];
    }[];
    expect(pages.find((p) => p.path === 'api-reference')?.headings.length).toBeGreaterThan(1);
  });

  it('serves the docs to a delivery-only principal', async () => {
    // The docs are the same for every space and say nothing about anyone's
    // content. Gating them on content:manage would withhold them from exactly
    // the agent most likely to need them.
    const client = await connect(deps, cda);
    expect(
      (payload(await client.callTool({ name: 'docs_list', arguments: {} })) as []).length,
    ).toBeGreaterThan(0);
  });

  it('reads one section rather than a whole page', async () => {
    const client = await connect(deps, adminPrincipal);
    const whole = payload(
      await client.callTool({ name: 'docs_read', arguments: { path: 'architecture' } }),
    ) as { body: string };
    const pages = payload(await client.callTool({ name: 'docs_list', arguments: {} })) as {
      path: string;
      headings: { depth: number; slug: string }[];
    }[];
    const slug = pages.find((p) => p.path === 'architecture')?.headings.find((h) => h.depth === 2)
      ?.slug as string;
    const part = payload(
      await client.callTool({
        name: 'docs_read',
        arguments: { path: 'architecture', section: slug },
      }),
    ) as { body: string };
    expect(part.body.length).toBeLessThan(whole.body.length);
  });

  it('reports a missing page as an error rather than an empty body', async () => {
    const client = await connect(deps, adminPrincipal);
    const res = await client.callTool({ name: 'docs_read', arguments: { path: 'nope' } });
    // An empty body reads as "this page is blank", which would send an agent
    // off to invent conventions the docs actually state.
    expect(res.isError).toBe(true);
  });

  it('searches across pages and says where each hit is', async () => {
    const client = await connect(deps, adminPrincipal);
    const hits = payload(
      await client.callTool({ name: 'docs_search', arguments: { query: 'UUIDv7' } }),
    ) as { path: string; line: number }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.line).toBeGreaterThan(0);
  });
});

describe('importing over MCP', () => {
  const item = (id: string, type: string) =>
    `<item><title>T${id}</title><wp:post_id>${id}</wp:post_id><wp:status>publish</wp:status><wp:post_type>${type}</wp:post_type></item>`;
  const WXR = `<rss xmlns:wp="http://wordpress.org/export/1.2/"><channel><wp:wxr_version>1.2</wp:wxr_version>${item('1', 'post')}${item('2', 'page')}${item('3', 'page')}</channel></rss>`;

  it('passes source options through, so an agent can choose what a WordPress export yields', async () => {
    // Without sourceOptions an agent could only ever read posts — the HTTP
    // surface could ask for pages and MCP could not.
    const deps = { ...makeDeps(), importSources: structuredImportSources() };
    await seed(deps);
    const client = await connect(deps, adminPrincipal);
    const analysis = payload(
      await client.callTool({
        name: 'import_analyze',
        arguments: {
          source: 'wxr',
          payload: WXR,
          contentTypeApiId: 'article',
          fields: { title: 'title' },
          sourceOptions: { postType: 'page' },
          space: SPACE,
        },
      }),
    ) as { records: number; willCreate: number };
    expect(analysis).toMatchObject({ records: 2, willCreate: 2 });
  });
});

describe('video asset tools', () => {
  it('creates a video upload and refreshes it through the same use-cases as the API', async () => {
    const deps = makeDeps();
    const video = new FakeVideoHost();
    const withVideo: McpDeps = { ...deps, ctx: { ...deps.ctx, video } };
    await seed(withVideo);
    const client = await connect(withVideo, adminPrincipal);

    const created = payload(
      await client.callTool({
        name: 'asset_video_create',
        arguments: { fileName: 'clip.mp4', contentType: 'video/mp4', space: SPACE },
      }),
    ) as { asset: { id: string }; upload: { uploadUrl: string } };
    expect(created.upload.uploadUrl).toBe('https://upload.video.local/vid-1');

    video.setVideo('vid-1', { status: 'ready', thumbnailUrl: 'https://cdn/t.jpg' });
    const refreshed = payload(
      await client.callTool({
        name: 'asset_video_refresh',
        arguments: { id: created.asset.id, space: SPACE },
      }),
    ) as { file: { video: { status: string; thumbnailUrl: string } } };
    expect(refreshed.file.video).toMatchObject({
      status: 'ready',
      thumbnailUrl: 'https://cdn/t.jpg',
    });
  });

  it('refuses a read-only principal', async () => {
    const deps = makeDeps();
    const withVideo: McpDeps = { ...deps, ctx: { ...deps.ctx, video: new FakeVideoHost() } };
    await seed(withVideo);
    const reader: Principal = { spaceId: SPACE, kind: 'cda', scopes: [SCOPES.deliveryRead] };
    const client = await connect(withVideo, reader);
    const res = await client.callTool({
      name: 'asset_video_create',
      arguments: { fileName: 'clip.mp4', contentType: 'video/mp4', space: SPACE },
    });
    expect(res.isError).toBe(true);
  });
});

describe('MCP writes held to expectedVersion', () => {
  it('refuses entries_publish, entries_unpublish and entries_restore_version on a moved entry', async () => {
    const deps = makeDeps();
    await seed(deps);
    const client = await connect(deps, adminPrincipal);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { space: SPACE, environment: 'main', ...args } });
    const { entry } = payload(
      await call('entries_create', {
        contentType: 'article',
        fields: { title: { 'en-US': 'Seen' } },
      }),
    ) as { entry: { id: string } };
    const id = entry.id;
    await call('entries_update', { id, fields: { title: { 'en-US': 'Unseen' } } });

    const stale = await call('entries_publish', { id, expectedVersion: 1 });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toMatch(/version 2, not 1/);
    expect((payload(await call('entries_get', { id })) as { status: string }).status).toBe('draft');

    expect((await call('entries_publish', { id, expectedVersion: 2 })).isError).toBeFalsy();
    await call('entries_update', { id, fields: { title: { 'en-US': 'Later' } } });
    expect((await call('entries_unpublish', { id, expectedVersion: 2 })).isError).toBe(true);
    expect(
      (await call('entries_restore_version', { id, version: 1, expectedVersion: 2 })).isError,
    ).toBe(true);
    expect(
      (await call('entries_restore_version', { id, version: 1, expectedVersion: 3 })).isError,
    ).toBeFalsy();
  });
});

describe('blocks fields over MCP', () => {
  it('defines a blocks type, then creates, publishes and reads an entry with keyed blocks', async () => {
    const deps = makeDeps();
    await seed(deps);
    const client = await connect(deps, adminPrincipal);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: { space: SPACE, environment: 'main', ...args } });
    const leaf = (apiId: string) => ({
      apiId,
      name: apiId,
      type: 'Symbol',
      localized: false,
      required: true,
      position: 0,
    });

    const defined = await call('model_create_content_type', {
      apiId: 'promo',
      name: 'Promo',
      displayField: 'title',
      fields: [
        leaf('title'),
        {
          apiId: 'body',
          name: 'Body',
          type: 'Array',
          position: 1,
          items: {
            type: 'Component',
            variants: [
              { apiId: 'hero', name: 'Hero', fields: [leaf('heading')] },
              { apiId: 'cta', name: 'CTA', fields: [leaf('label')] },
            ],
          },
        },
        // A plain component keeps its nested fields through the tool's schema.
        { apiId: 'meta', name: 'Meta', type: 'Component', position: 2, fields: [leaf('kicker')] },
      ],
    });
    expect(defined.isError).toBeFalsy();
    const type = payload(defined) as { fields: { apiId: string; fields?: unknown[] }[] };
    expect(type.fields.find((f) => f.apiId === 'meta')?.fields).toHaveLength(1);
    await call('model_publish_content_type', { apiId: 'promo' });

    const bad = await call('entries_create', {
      contentType: 'promo',
      fields: { title: { 'en-US': 'x' }, body: { 'en-US': [{ _type: 'quote' }] } },
    });
    // Refused by the same validator the API uses (which names `body[0]` there).
    expect(bad.isError).toBe(true);

    const { entry } = payload(
      await call('entries_create', {
        contentType: 'promo',
        fields: {
          title: { 'en-US': 'Spring' },
          body: {
            'en-US': [
              { _type: 'hero', heading: 'Hi' },
              { _type: 'cta', label: 'Go' },
            ],
          },
        },
      }),
    ) as { entry: { id: string } };
    expect((await call('entries_publish', { id: entry.id })).isError).toBeFalsy();
    const read = payload(await call('entries_get', { id: entry.id })) as {
      fields: { body: Record<string, { _type: string; _key: string }[]> };
    };
    const blocks = read.fields.body['en-US'] ?? [];
    expect(blocks.map((b) => b._type)).toEqual(['hero', 'cta']);
    expect(blocks.every((b) => typeof b._key === 'string' && b._key.length > 0)).toBe(true);
  });
});
