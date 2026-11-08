import {
  archiveAsset,
  assetSearchDeps,
  createAssetFolder,
  deleteAsset,
  deleteAssetFolder,
  getAsset,
  getPreviewAsset,
  listAssetFolders,
  listAssets,
  listPreviewAssets,
  MAX_ASSET_MOVE,
  moveAssets,
  publishAsset,
  reingestAsset,
  restoreAsset,
  searchAssets,
  searchDeliveredAssets,
  startAssetReindex,
  unpublishAsset,
  updateAssetFolder,
} from '@commerceworker/application';
import {
  ASSET_KINDS,
  AssetInUseError,
  ForbiddenError,
  NotConfiguredError,
  SCOPES,
} from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  ok,
  rightsRefusal,
  scopeArgs,
  scopeOf,
  signedAssets,
  type ToolContext,
  toolSchema,
} from './shared';

export function registerAssetTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, rag, principal, guard } = t;
  // --- assets / media intelligence ---------------------------------------
  const emptyFacets = { kind: {}, tag: {}, folder: {} };
  const assetSearch = deps.assetSearch ?? assetSearchDeps(rag);
  const { signedOne, signedPage } = signedAssets(deps);
  server.registerTool(
    'assets_list',
    {
      description:
        'List the asset library in a space/environment, one page at a time: filter by kind, ' +
        'content type, tag, folder and status (archived assets are left out unless asked for), ' +
        'sort, and pass nextCursor back as cursor for the next page.',
      inputSchema: toolSchema('assets_list', () =>
        z.object({
          limit: z.number().int().positive().max(100).optional(),
          cursor: z.string().optional().describe('nextCursor from the previous page'),
          kind: z.enum(ASSET_KINDS as unknown as [string, ...string[]]).optional(),
          mime: z.string().max(256).optional().describe('exact (image/png) or family (image/*)'),
          tag: z.string().max(128).optional().describe('taxonomy tag id'),
          folderId: z
            .string()
            .nullable()
            .optional()
            .describe('assets filed in this folder; null for those in no folder'),
          status: z.enum(['draft', 'published', 'archived', 'all']).optional(),
          sort: z.enum(['updatedAt', 'createdAt', 'size']).optional(),
          order: z.enum(['asc', 'desc']).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await signedPage(
          scopeOf(args),
          await listAssets(ctx, scopeOf(args), {
            ...(args.limit ? { limit: args.limit } : {}),
            ...(args.cursor ? { cursor: args.cursor } : {}),
            filters: {
              ...(args.kind ? { kind: args.kind as (typeof ASSET_KINDS)[number] } : {}),
              ...(args.mime ? { mime: args.mime } : {}),
              ...(args.tag ? { tag: args.tag } : {}),
              ...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
              ...(args.status ? { status: args.status } : {}),
            },
            ...(args.sort || args.order
              ? { sort: { field: args.sort ?? 'updatedAt', direction: args.order ?? 'desc' } }
              : {}),
          }),
        ),
      );
    },
  );

  server.registerTool(
    'assets_search',
    {
      description:
        'Search assets: full text (file name, title, caption, alt text, tag names, text read ' +
        'from documents and recordings) and semantic similarity, fused by rank, best match ' +
        'first, with facet counts by kind, tag and folder. The library by default (drafts and ' +
        'published; archived only when status asks); delivered: true searches what Delivery ' +
        'serves (published only, in the delivered shape) and needs delivery read access.',
      inputSchema: toolSchema('assets_search', () =>
        z.object({
          q: z.string().min(1).max(256),
          limit: z.number().int().positive().max(100).optional(),
          kind: z.enum(ASSET_KINDS as unknown as [string, ...string[]]).optional(),
          tag: z.string().max(128).optional().describe('taxonomy tag id'),
          folderId: z
            .string()
            .nullable()
            .optional()
            .describe('assets filed in this folder; null for those in no folder'),
          status: z.enum(['draft', 'published', 'archived', 'all']).optional(),
          delivered: z.boolean().optional().describe('search published assets as Delivery serves'),
          locale: z
            .string()
            .optional()
            .describe('with delivered: resolve title, description and alt text for one locale'),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const query = {
        q: args.q,
        ...(args.limit ? { limit: args.limit } : {}),
        filters: {
          ...(args.kind ? { kind: args.kind as (typeof ASSET_KINDS)[number] } : {}),
          ...(args.tag ? { tag: args.tag } : {}),
          ...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
          ...(args.status && !args.delivered ? { status: args.status } : {}),
        },
      };
      if (args.delivered) {
        // As the delivery route's ?q=: delivery:read and search:read.
        guard(SCOPES.deliveryRead, scopeOf(args));
        guard(SCOPES.searchRead, scopeOf(args));
        // As the delivery route: a key with content grants reads no assets.
        if (principal.contentGrants) return ok({ items: [], total: 0, facets: emptyFacets });
        return ok(
          await searchDeliveredAssets(
            ctx,
            assetSearch,
            scopeOf(args),
            query,
            args.locale !== undefined ? { locale: args.locale } : {},
          ),
        );
      }
      guard(SCOPES.previewRead, scopeOf(args));
      const page = await searchAssets(ctx, assetSearch, scopeOf(args), query);
      return ok({
        ...page,
        items: await Promise.all(page.items.map((a) => signedOne(scopeOf(args), a))),
      });
    },
  );

  server.registerTool(
    'asset_get',
    {
      description:
        'Get one asset as it stands (its draft): file (url a short-lived signed read URL; a ' +
        'hosted video’s playback URLs in file.video), title, description, metadata, rights, ' +
        'version, status and ingest state.',
      inputSchema: toolSchema('asset_get', () => z.object({ id: z.string(), ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await signedOne(scopeOf(args), await getAsset(ctx, scopeOf(args), args.id)));
    },
  );

  server.registerTool(
    'asset_publish',
    {
      description:
        'Publish one asset: Delivery serves its current file and metadata from then on. Refused ' +
        'before its embargo lifts (asset_embargoed, with embargoUntil) and after its rights ' +
        'expired (asset_expired, with expiresAt), as REST refuses them; an archived asset too.',
      inputSchema: toolSchema('asset_publish', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return rightsRefusal(async () =>
        ok(await signedOne(scopeOf(args), await publishAsset(ctx, scopeOf(args), args.id))),
      );
    },
  );

  server.registerTool(
    'asset_unpublish',
    {
      description: 'Take one asset out of Delivery; it stays a draft. Refused when not published.',
      inputSchema: toolSchema('asset_unpublish', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await signedOne(scopeOf(args), await unpublishAsset(ctx, scopeOf(args), args.id)));
    },
  );

  server.registerTool(
    'asset_reingest',
    {
      description:
        "Run ingest on an asset's current file again: hash and duplicate check, dimensions, alt " +
        'text and tags where empty (as AI suggestions), text extraction, search index. For a ' +
        'retry after ingestStatus error. Refused for hosted videos.',
      inputSchema: toolSchema('asset_reingest', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      if (!deps.assetIngest) {
        throw new NotConfiguredError('asset ingest', 'Bind ASSET_EVENTS_QUEUE to re-run ingest');
      }
      return ok(
        await signedOne(
          scopeOf(args),
          await reingestAsset(ctx, deps.assetIngest, scopeOf(args), args.id),
        ),
      );
    },
  );

  server.registerTool(
    'assets_reindex',
    {
      description:
        'Send the asset library through ingest as a resumable bulk job: assets never ingested ' +
        '(uploaded before ingest) or whose ingest failed, or every asset with a file (all: ' +
        'true). While a reindex is running, that job comes back instead (running: true). ' +
        'Follow the job with bulk_job_status. Refused when the ingest queue is not bound.',
      inputSchema: toolSchema('assets_reindex', () =>
        z.object({ all: z.boolean().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      if (!deps.assetIngest) {
        throw new NotConfiguredError('asset ingest', 'Bind ASSET_EVENTS_QUEUE to reindex assets');
      }
      return ok(await startAssetReindex(ctx, scopeOf(args), { all: args.all === true }));
    },
  );

  // Preview's asset reads (`GET /preview/…/assets[/:id]`): drafts included, archived left out, in
  // the shape Delivery serves, every URL signed and short-lived. Same scope and the same refusal
  // of a content-granted key as the REST routes.
  const previewBlob = () => {
    if (!deps.blob) throw new NotConfiguredError('blob', 'Preview asset reads need a blob store');
    return deps.blob;
  };
  server.registerTool(
    'asset_preview_list',
    {
      description:
        'List the asset library as Preview serves it: drafts and published (archived left out), ' +
        'in the delivered shape (url, renditions, srcset, placeholder) with short-lived signed ' +
        'URLs. Filter ' +
        'by kind, tag or folder; pass nextCursor back as cursor for the next page. A key with ' +
        'content grants reads none.',
      inputSchema: toolSchema('asset_preview_list', () =>
        z.object({
          limit: z.number().int().positive().max(100).optional(),
          cursor: z.string().optional().describe('nextCursor from the previous page'),
          kind: z.enum(ASSET_KINDS as unknown as [string, ...string[]]).optional(),
          tag: z.string().max(128).optional().describe('taxonomy tag id'),
          folderId: z
            .string()
            .nullable()
            .optional()
            .describe('assets filed in this folder; null for those in no folder'),
          locale: z
            .string()
            .optional()
            .describe('resolve title, description and alt text for one locale'),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      // As the REST route: a key with content grants reads no assets.
      if (principal.contentGrants) return ok({ items: [], total: 0 });
      const page = await listPreviewAssets(
        ctx,
        previewBlob(),
        scopeOf(args),
        {
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
          filters: {
            ...(args.kind ? { kind: args.kind as (typeof ASSET_KINDS)[number] } : {}),
            ...(args.tag ? { tag: args.tag } : {}),
            ...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
          },
        },
        args.locale !== undefined ? { locale: args.locale } : {},
      );
      return ok({ ...page, total: page.items.length });
    },
  );

  server.registerTool(
    'asset_preview_get',
    {
      description:
        'Get one asset as Preview serves it, draft or published (not archived), in the ' +
        'delivered shape with short-lived signed URLs. Refused for a key with content grants.',
      inputSchema: toolSchema('asset_preview_get', () =>
        z.object({
          id: z.string(),
          locale: z
            .string()
            .optional()
            .describe('resolve title, description and alt text for one locale'),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      if (principal.contentGrants) {
        throw new ForbiddenError('assets (a key with content grants reads no assets)');
      }
      return ok(
        await getPreviewAsset(
          ctx,
          previewBlob(),
          scopeOf(args),
          args.id,
          args.locale !== undefined ? { locale: args.locale } : {},
        ),
      );
    },
  );

  server.registerTool(
    'assets_move',
    {
      description: `File assets in a folder (folderId null: the library root), up to ${MAX_ASSET_MOVE} at once. Ids that are not assets here are skipped.`,
      inputSchema: toolSchema('assets_move', () =>
        z.object({
          ids: z.array(z.string()).min(1).max(MAX_ASSET_MOVE),
          folderId: z.string().nullable(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await moveAssets(ctx, scopeOf(args), { ids: args.ids, folderId: args.folderId }));
    },
  );

  server.registerTool(
    'asset_archive',
    {
      description:
        'Archive an asset: it leaves Delivery at once when published and is hidden from the ' +
        'default listing until restored. Idempotent.',
      inputSchema: toolSchema('asset_archive', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await signedOne(scopeOf(args), await archiveAsset(ctx, scopeOf(args), args.id)));
    },
  );

  server.registerTool(
    'asset_restore',
    {
      description: 'Restore an archived asset as a draft (publish it again separately).',
      inputSchema: toolSchema('asset_restore', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await signedOne(scopeOf(args), await restoreAsset(ctx, scopeOf(args), args.id)));
    },
  );

  server.registerTool(
    'asset_delete',
    {
      description:
        'Delete an archived asset permanently, with its files: asset_archive it first, which ' +
        'asset_restore can undo. Refused while entries, drafts included, link to it: the result ' +
        'then lists those links (usage); remove them first.',
      inputSchema: toolSchema('asset_delete', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      try {
        await deleteAsset(ctx, scopeOf(args), args.id);
      } catch (err) {
        if (!(err instanceof AssetInUseError)) throw err;
        return {
          ...ok({
            error: { code: err.code, message: err.message, usage: err.usage, total: err.total },
          }),
          isError: true,
        };
      }
      return ok({ deleted: args.id });
    },
  );

  server.registerTool(
    'asset_folders_list',
    {
      description: 'List the asset library’s folders, a parent before its children.',
      inputSchema: toolSchema('asset_folders_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listAssetFolders(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'asset_folders_create',
    {
      description:
        'Create an asset folder at the root or inside parentId. Sibling names are unique.',
      inputSchema: toolSchema('asset_folders_create', () =>
        z.object({
          name: z.string().min(1).max(128),
          parentId: z.string().nullable().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await createAssetFolder(ctx, scopeOf(args), { name: args.name, parentId: args.parentId }),
      );
    },
  );

  server.registerTool(
    'asset_folders_update',
    {
      description:
        'Rename an asset folder and/or move it (parentId null: to the root). A move takes its ' +
        'subfolders along.',
      inputSchema: toolSchema('asset_folders_update', () =>
        z.object({
          id: z.string(),
          name: z.string().min(1).max(128).optional(),
          parentId: z.string().nullable().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await updateAssetFolder(ctx, scopeOf(args), args.id, {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'asset_folders_delete',
    {
      description: 'Delete an empty asset folder (one with subfolders or assets is refused).',
      inputSchema: toolSchema('asset_folders_delete', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await deleteAssetFolder(ctx, scopeOf(args), args.id);
      return ok({ deleted: args.id });
    },
  );
}
