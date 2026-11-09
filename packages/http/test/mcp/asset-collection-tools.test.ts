import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createAsset,
  createSpace,
  publishAsset,
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
const scope = { spaceId: SPACE, environmentId: 'main' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const reader: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };
const writer: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite],
};

async function setup() {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
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
  await createSpace(ctx, { spaceId: SPACE, name: 'Shop', defaultLocale: 'en-US' });
  const add = async (fileName: string) =>
    (await createAsset(ctx, blob, scope, { fileName, contentType: 'image/png' })).asset;
  return { ctx, deps, add, blob };
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

describe('collection, share, upload and zip tools (MCP), on the HTTP routes’ use-cases', () => {
  it('manages a collection end to end', async () => {
    const { deps, add } = await setup();
    const [a, b] = [await add('a.png'), await add('b.png')];
    const call = await connect(deps, admin);
    const c = (await call('asset_collections_create', { name: 'Kit' })).body as { id: string };
    expect(
      (await call('asset_collection_assets_add', { id: c.id, assetIds: [a.id, b.id] })).body,
    ).toEqual({
      added: 2,
      skipped: [],
    });
    await call('asset_collection_reorder', { id: c.id, assetIds: [b.id] });
    const page = (await call('asset_collection_assets_list', { id: c.id })).body as {
      items: { id: string }[];
    };
    expect(page.items.map((x) => x.id)).toEqual([b.id, a.id]);
    await call('asset_collection_assets_remove', { id: c.id, assetIds: [b.id] });
    expect((await call('asset_collections_get', { id: c.id })).body).toMatchObject({
      itemCount: 1,
    });
    await call('asset_collections_update', { id: c.id, name: 'Renamed' });
    const list = (await call('asset_collections_list')).body as { items: { name: string }[] };
    expect(list.items.map((x) => x.name)).toEqual(['Renamed']);
    expect((await call('asset_collections_delete', { id: c.id })).body).toEqual({ deleted: c.id });
  });

  it('holds the same scopes as REST: reading needs preview:read, changing content:write', async () => {
    const { deps } = await setup();
    const asReader = await connect(deps, reader);
    expect((await asReader('asset_collections_list')).isError).toBe(false);
    expect((await asReader('asset_collections_create', { name: 'X' })).isError).toBe(true);
    const asWriter = await connect(deps, writer);
    expect((await asWriter('asset_collections_create', { name: 'X' })).isError).toBe(false);
    // Share links need content:publish, even to list (the list carries the URLs).
    expect((await asWriter('share_links_list')).isError).toBe(true);
    expect(
      (await asReader('asset_upload_start', { fileName: 'a', contentType: 'a/b', size: 1 }))
        .isError,
    ).toBe(true);
  });

  it('creates, lists and revokes a share link, never returning its password', async () => {
    const { ctx, deps, add } = await setup();
    const a = await add('a.png');
    await publishAsset(ctx, scope, a.id);
    const call = await connect(deps, admin);
    const link = (await call('share_link_create', {
      targetType: 'asset',
      targetId: a.id,
      expiresAt: new Date(Date.parse('2026-01-01T00:00:00Z') + 86_400_000).toISOString(),
      password: 'long enough',
    })) as { body: { id: string; hasPassword: boolean }; text: string };
    expect(link.body.hasPassword).toBe(true);
    expect(link.text).not.toContain('long enough');
    expect(((await call('share_links_list')).body as { items: unknown[] }).items).toHaveLength(1);
    expect(((await call('share_link_get', { id: link.body.id })).body as { id: string }).id).toBe(
      link.body.id,
    );
    const revoked = (await call('share_link_revoke', { id: link.body.id })).body as {
      revokedAt?: string;
    };
    expect(revoked.revokedAt).toBeDefined();
  });

  it('uploads in parts and asks for a zip', async () => {
    const { deps, blob } = await setup();
    const call = await connect(deps, admin);
    const started = (
      await call('asset_upload_start', {
        fileName: 'big.bin',
        contentType: 'application/octet-stream',
        size: 12,
      })
    ).body as { asset: { id: string }; upload: { uploadId: string } };
    const signed = (
      await call('asset_upload_parts', {
        id: started.asset.id,
        uploadId: started.upload.uploadId,
        partNumbers: [1],
      })
    ).body as { parts: { partNumber: number; length: number }[] };
    expect(signed.parts).toEqual([expect.objectContaining({ partNumber: 1, length: 12 })]);
    const part = await blob.multipart.uploadPart(
      `${SPACE}/main/${started.asset.id}/big.bin`,
      started.upload.uploadId,
      1,
      new Uint8Array(12),
    );
    const done = await call('asset_upload_complete', {
      id: started.asset.id,
      uploadId: started.upload.uploadId,
      parts: [part],
    });
    expect(done.isError).toBe(false);
    const zip = (await call('asset_zip_create', { assetIds: [started.asset.id] })).body as {
      id: string;
      status: string;
    };
    expect(zip.status).toBe('pending');
    expect(((await call('asset_zip_get', { id: zip.id })).body as { id: string }).id).toBe(zip.id);
    expect(((await call('asset_zips_list')).body as { items: unknown[] }).items).toHaveLength(1);
    const aborted = (
      await call('asset_upload_start', { fileName: 'x.bin', contentType: 'a/b', size: 3 })
    ).body as {
      asset: { id: string };
      upload: { uploadId: string };
    };
    expect(
      (
        await call('asset_upload_abort', {
          id: aborted.asset.id,
          uploadId: aborted.upload.uploadId,
        })
      ).body,
    ).toEqual({ aborted: aborted.upload.uploadId });
  });

  it('replaces a file in parts through the upload tools, committing on completion', async () => {
    const { deps, add, blob } = await setup();
    const a = await add('hero.png');
    await blob.put(`${SPACE}/main/${a.id}/hero.png`, 'v1', 'image/png');
    const asReader = await connect(deps, reader);
    expect(
      (
        await asReader('asset_replace_file_upload', {
          id: a.id,
          fileName: 'b.png',
          contentType: 'image/png',
          size: 12,
        })
      ).isError,
    ).toBe(true);
    const call = await connect(deps, writer);
    const started = (
      await call('asset_replace_file_upload', {
        id: a.id,
        fileName: 'b.png',
        contentType: 'image/png',
        size: 12,
      })
    ).body as { version: number; upload: { uploadId: string } };
    expect(started.version).toBe(2);
    const key = blob.uploadsInProgress.get(started.upload.uploadId)?.key ?? '';
    expect(key).toMatch(new RegExp(`^${SPACE}/main/${a.id}/v2/file-[^/]+/b\\.png$`));
    const part = await blob.multipart.uploadPart(
      key,
      started.upload.uploadId,
      1,
      new Uint8Array(12),
    );
    const done = await call('asset_upload_complete', {
      id: a.id,
      uploadId: started.upload.uploadId,
      parts: [part],
    });
    expect(done.isError).toBe(false);
    expect(done.body).toMatchObject({ version: 2, file: { fileName: 'b.png', size: 12 } });
  });

  it('refuses a key with content grants on zips and collection members, as on asset reads', async () => {
    const { deps, add } = await setup();
    const a = await add('a.png');
    const asAdmin = await connect(deps, admin);
    const c = (await asAdmin('asset_collections_create', { name: 'K' })).body as { id: string };
    await asAdmin('asset_collection_assets_add', { id: c.id, assetIds: [a.id] });
    const pdf = (
      await asAdmin('asset_collection_assets_list', { id: c.id, mime: 'application/pdf' })
    ).body as { items: unknown[] };
    expect(pdf.items).toEqual([]);
    const granted = await connect(deps, { ...reader, contentGrants: [] });
    expect((await granted('asset_zip_create', { assetIds: [a.id] })).isError).toBe(true);
    expect((await granted('asset_collection_assets_list', { id: c.id })).isError).toBe(true);
    expect((await granted('asset_collections_list')).isError).toBe(false);
  });
});
