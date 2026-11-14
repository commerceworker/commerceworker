import {
  abortMultipartAssetUpload,
  addToAssetCollection,
  auditActor,
  completeMultipartAssetUpload,
  createAsset,
  createAssetCollection,
  createAssetRendition,
  createAssetShareLink,
  deleteAssetCollection,
  deleteAssetRendition,
  getAssetCollection,
  getAssetShareLink,
  getAssetZip,
  listAssetCollectionItems,
  listAssetCollections,
  listAssetRenditions,
  listAssetShareLinks,
  listAssetZips,
  MAX_PAGE_LIMIT,
  MAX_PART_URLS,
  removeFromAssetCollection,
  reorderAssetCollection,
  requestAssetZip,
  revokeAssetShareLink,
  setAssetMetadata,
  signAssetUploadParts,
  startMultipartAssetUpload,
  updateAssetCollection,
  updateAssetRendition,
} from '@commerceworker/application';
import {
  ForbiddenError,
  MAX_COLLECTION_CHANGE,
  MAX_COLLECTION_DESCRIPTION,
  MAX_COLLECTION_ITEMS,
  MAX_SHARE_PASSWORD,
  MAX_ZIP_ASSETS,
  NotConfiguredError,
  type RenditionFit,
  type RenditionFormat,
  SCOPES,
} from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { assetMetadataPatchShape, createAssetBody } from '../../api/validation';
import { ok, scopeArgs, signedAssets, type ToolContext, toolSchema } from './shared';

export function registerAssetCollectionTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { deps, ctx, principal, guard } = t;
  const { signedOne, signedPage } = signedAssets(deps);
  // --- collections, share links, multipart uploads, zip downloads ---------------------------
  // The same use-cases and scopes as the REST routes: collections are content:write to change
  // and preview:read to read; share links are content:publish throughout (a link, and the list
  // that carries the URLs, opens published files to anyone); uploads content:write; a zip
  // preview:read.
  const collectionAuthor = auditActor(principal);
  // A key with content grants reads no assets (as the preview asset tools refuse it).
  const refuseGrantedAssetReads = () => {
    if (principal.contentGrants) {
      throw new ForbiddenError('assets (a key with content grants reads no assets)');
    }
  };
  const uploadBlob = () => {
    if (!deps.blob) throw new NotConfiguredError('blob', 'Uploads and zips need a blob store');
    return deps.blob;
  };

  server.registerTool(
    'asset_collections_list',
    {
      description:
        'List asset collections (named, ordered sets of assets; an asset may be in many), by ' +
        'name. Page with nextCursor.',
      inputSchema: toolSchema('asset_collections_list', () =>
        z.object({
          limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
          cursor: z.string().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await listAssetCollections(ctx, scopeOf(args), {
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'asset_collections_get',
    {
      description: 'Get one asset collection (with how many assets it holds).',
      inputSchema: toolSchema('asset_collections_get', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getAssetCollection(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'asset_collections_create',
    {
      description: 'Create an asset collection.',
      inputSchema: toolSchema('asset_collections_create', () =>
        z.object({
          name: z.string().min(1).max(128),
          description: z.string().max(MAX_COLLECTION_DESCRIPTION).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await createAssetCollection(
          ctx,
          scopeOf(args),
          {
            name: args.name,
            ...(args.description !== undefined ? { description: args.description } : {}),
          },
          { createdBy: collectionAuthor },
        ),
      );
    },
  );

  server.registerTool(
    'asset_collections_update',
    {
      description: 'Rename an asset collection or change its description ("" clears it).',
      inputSchema: toolSchema('asset_collections_update', () =>
        z.object({
          id: z.string(),
          name: z.string().min(1).max(128).optional(),
          description: z.string().max(MAX_COLLECTION_DESCRIPTION).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await updateAssetCollection(ctx, scopeOf(args), args.id, {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'asset_collections_delete',
    {
      description: 'Delete an asset collection. Its assets stay in the library.',
      inputSchema: toolSchema('asset_collections_delete', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await deleteAssetCollection(ctx, scopeOf(args), args.id);
      return ok({ deleted: args.id });
    },
  );

  server.registerTool(
    'asset_collection_assets_list',
    {
      description:
        'List a collection’s assets in its order, filtered as the library is (archived ' +
        'members left out unless status asks), with short-lived signed URLs. Page with nextCursor.',
      inputSchema: toolSchema('asset_collection_assets_list', () =>
        z.object({
          id: z.string(),
          kind: z.enum(['image', 'video', 'audio', 'document', 'other']).optional(),
          mime: z
            .string()
            .optional()
            .describe('An exact content type (image/png) or a family (image/*)'),
          tag: z.string().optional(),
          status: z.enum(['draft', 'published', 'archived', 'all']).optional(),
          limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
          cursor: z.string().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      refuseGrantedAssetReads();
      const page = await listAssetCollectionItems(ctx, scopeOf(args), args.id, {
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
        filters: {
          ...(args.kind ? { kind: args.kind } : {}),
          ...(args.mime ? { mime: args.mime } : {}),
          ...(args.tag ? { tag: args.tag } : {}),
          ...(args.status ? { status: args.status } : {}),
        },
      });
      return ok(await signedPage(scopeOf(args), page));
    },
  );

  server.registerTool(
    'asset_collection_assets_add',
    {
      description: `Add assets to a collection after its last member, in the order given (up to ${MAX_COLLECTION_CHANGE} ids). A collection holds at most ${MAX_COLLECTION_ITEMS}. Ids that are not assets here are returned in skipped.`,
      inputSchema: toolSchema('asset_collection_assets_add', () =>
        z.object({
          id: z.string(),
          assetIds: z.array(z.string()).min(1).max(MAX_COLLECTION_CHANGE),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await addToAssetCollection(ctx, scopeOf(args), args.id, args.assetIds));
    },
  );

  server.registerTool(
    'asset_collection_assets_remove',
    {
      description: 'Remove assets from a collection (they stay in the library).',
      inputSchema: toolSchema('asset_collection_assets_remove', () =>
        z.object({
          id: z.string(),
          assetIds: z.array(z.string()).min(1).max(MAX_COLLECTION_CHANGE),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await removeFromAssetCollection(ctx, scopeOf(args), args.id, args.assetIds));
    },
  );

  server.registerTool(
    'asset_collection_reorder',
    {
      description:
        'Reorder a collection: the named members go first, in that order; the rest follow as ' +
        'they were. Name every member to set the whole order.',
      inputSchema: toolSchema('asset_collection_reorder', () =>
        z.object({
          id: z.string(),
          assetIds: z.array(z.string()).min(1).max(MAX_COLLECTION_ITEMS),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await reorderAssetCollection(ctx, scopeOf(args), args.id, args.assetIds);
      return ok({ reordered: args.id });
    },
  );

  server.registerTool(
    'share_links_list',
    {
      description:
        'List share links (newest first), active only unless includeInactive. Each carries its ' +
        'URL on the media origin.',
      inputSchema: toolSchema('share_links_list', () =>
        z.object({
          targetType: z.enum(['asset', 'collection']).optional(),
          targetId: z.string().optional(),
          includeInactive: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok({
        items: await listAssetShareLinks(ctx, scopeOf(args), {
          ...(args.targetType ? { targetType: args.targetType } : {}),
          ...(args.targetId ? { targetId: args.targetId } : {}),
          includeInactive: args.includeInactive === true,
        }),
      });
    },
  );

  server.registerTool(
    'share_link_create',
    {
      description:
        'Create an expiring share link to a published asset or a collection: a read-only page ' +
        'on the media origin of what it publishes now (never a draft), for anyone with the ' +
        'URL. expiresAt is 5 minutes to 90 days out; a password is asked for before the page ' +
        'opens (hashed, never stored).',
      inputSchema: toolSchema('share_link_create', () =>
        z.object({
          targetType: z.enum(['asset', 'collection']),
          targetId: z.string(),
          expiresAt: z.string().describe('ISO 8601'),
          allowDownload: z.boolean().optional(),
          password: z.string().min(8).max(MAX_SHARE_PASSWORD).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(
        await createAssetShareLink(
          ctx,
          scopeOf(args),
          {
            targetType: args.targetType,
            targetId: args.targetId,
            expiresAt: args.expiresAt,
            ...(args.allowDownload !== undefined ? { allowDownload: args.allowDownload } : {}),
            ...(args.password !== undefined ? { password: args.password } : {}),
          },
          { createdBy: collectionAuthor },
        ),
      );
    },
  );

  server.registerTool(
    'share_link_get',
    {
      description: 'Get one share link by id (active, expired or revoked), with its URL.',
      inputSchema: toolSchema('share_link_get', () => z.object({ id: z.string(), ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await getAssetShareLink(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'share_link_revoke',
    {
      description:
        'Revoke a share link: it stops opening within a minute and its cached page is purged.',
      inputSchema: toolSchema('share_link_revoke', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await revokeAssetShareLink(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'asset_create',
    {
      description:
        'Create a draft asset and get a signed PUT for its bytes (up to 100 MiB; past that, ' +
        'asset_upload_start): PUT the file to upload.url with upload.headers, then ' +
        'asset_publish. The URL is a short-lived capability for that one key; nothing is ' +
        'uploaded through MCP itself.',
      inputSchema: toolSchema('asset_create', () =>
        z.object({ ...createAssetBody.shape, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const { space: _space, environment: _environment, folderId, ...input } = args;
      const created = await createAsset(ctx, uploadBlob(), scopeOf(args), input, {
        createdBy: collectionAuthor,
        ...(folderId ? { folderId } : {}),
      });
      return ok({ ...created, asset: await signedOne(scopeOf(args), created.asset) });
    },
  );

  server.registerTool(
    'asset_upload_start',
    {
      description:
        'Create an asset with a multipart upload, for a file past 100 MiB (up to the ' +
        'deployment’s cap, 5 GiB by default). Then asset_upload_parts for part URLs, PUT each ' +
        'part (exactly its length), and asset_upload_complete with every part’s ETag.',
      inputSchema: toolSchema('asset_upload_start', () =>
        z.object({
          fileName: z.string().min(1).max(1024),
          contentType: z.string().min(1).max(256),
          size: z.number().int().min(1),
          folderId: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const started = await startMultipartAssetUpload(
        ctx,
        uploadBlob(),
        scopeOf(args),
        { fileName: args.fileName, contentType: args.contentType, size: args.size },
        { createdBy: collectionAuthor, ...(args.folderId ? { folderId: args.folderId } : {}) },
      );
      return ok({ ...started, asset: await signedOne(scopeOf(args), started.asset) });
    },
  );

  server.registerTool(
    'asset_upload_parts',
    {
      description: `Sign PUT URLs for parts of a multipart upload (up to ${MAX_PART_URLS} per call; sign one again to retry it).`,
      inputSchema: toolSchema('asset_upload_parts', () =>
        z.object({
          id: z.string().describe('The asset id'),
          uploadId: z.string(),
          partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(MAX_PART_URLS),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await signAssetUploadParts(
          ctx,
          uploadBlob(),
          scopeOf(args),
          args.id,
          args.uploadId,
          args.partNumbers,
        ),
      );
    },
  );

  server.registerTool(
    'asset_upload_complete',
    {
      description:
        'Complete a multipart upload with parts 1..n, each once, with its ETag. Ingest starts; ' +
        'a replacement’s (asset_replace_file_upload) commits its new version.',
      inputSchema: toolSchema('asset_upload_complete', () =>
        z.object({
          id: z.string().describe('The asset id'),
          uploadId: z.string(),
          parts: z
            .array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) }))
            .min(1)
            .max(10_000),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const asset = await completeMultipartAssetUpload(
        ctx,
        { blob: uploadBlob(), ...(deps.assetIngest ? { ingest: deps.assetIngest } : {}) },
        scopeOf(args),
        args.id,
        args.uploadId,
        args.parts,
        { by: auditActor(principal) },
      );
      return ok(await signedOne(scopeOf(args), asset));
    },
  );

  server.registerTool(
    'asset_upload_abort',
    {
      description:
        'Abort a multipart upload: its parts are discarded, and its draft deleted while it has ' +
        'no bytes.',
      inputSchema: toolSchema('asset_upload_abort', () =>
        z.object({ id: z.string(), uploadId: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await abortMultipartAssetUpload(ctx, uploadBlob(), scopeOf(args), args.id, args.uploadId);
      return ok({ aborted: args.uploadId });
    },
  );

  server.registerTool(
    'asset_zip_create',
    {
      description: `Zip a selection of assets (assetIds, up to ${MAX_ZIP_ASSETS}) or a collection (collectionId): a job that puts their current files in one archive. Poll asset_zip_get until completed for a 15-minute downloadUrl; the archive is kept a day.`,
      inputSchema: toolSchema('asset_zip_create', () =>
        z.object({
          assetIds: z.array(z.string()).min(1).max(MAX_ZIP_ASSETS).optional(),
          collectionId: z.string().optional(),
          name: z.string().max(100).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      refuseGrantedAssetReads();
      return ok(
        await requestAssetZip(
          ctx,
          scopeOf(args),
          {
            ...(args.assetIds ? { assetIds: args.assetIds } : {}),
            ...(args.collectionId ? { collectionId: args.collectionId } : {}),
            ...(args.name !== undefined ? { name: args.name } : {}),
          },
          { createdBy: collectionAuthor },
        ),
      );
    },
  );

  server.registerTool(
    'asset_zip_get',
    {
      description: 'Get a zip job: its progress, and once completed a 15-minute downloadUrl.',
      inputSchema: toolSchema('asset_zip_get', () => z.object({ id: z.string(), ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      refuseGrantedAssetReads();
      return ok(await getAssetZip(ctx, uploadBlob(), scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'asset_zips_list',
    {
      description: 'List recent zip jobs, newest first.',
      inputSchema: toolSchema('asset_zips_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      refuseGrantedAssetReads();
      return ok({ items: await listAssetZips(ctx, scopeOf(args)) });
    },
  );

  const renditionSpec = {
    width: z.number().int().min(1).max(4096).optional(),
    height: z.number().int().min(1).max(4096).optional(),
    fit: z.enum(['clip', 'crop', 'fill', 'max', 'scale']).optional(),
    format: z.enum(['auto', 'jpg', 'png', 'webp', 'avif']).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  };
  const specOf = (args: {
    width?: number;
    height?: number;
    fit?: RenditionFit;
    format?: RenditionFormat;
    quality?: number;
  }) => ({
    ...(args.width !== undefined ? { width: args.width } : {}),
    ...(args.height !== undefined ? { height: args.height } : {}),
    ...(args.fit !== undefined ? { fit: args.fit } : {}),
    ...(args.format !== undefined ? { format: args.format } : {}),
    ...(args.quality !== undefined ? { quality: args.quality } : {}),
  });

  server.registerTool(
    'asset_renditions_list',
    {
      description:
        'List the space’s rendition presets (named image sizes, the same in every environment). ' +
        'Delivered images carry a URL for each, at …/r-<name>/… on the media origin.',
      inputSchema: toolSchema('asset_renditions_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok({ items: await listAssetRenditions(ctx, scopeOf(args)) });
    },
  );

  server.registerTool(
    'asset_renditions_create',
    {
      description:
        'Create a rendition preset: a name (lowercase letters, digits, dashes) and what it does ' +
        '(width, height, fit, format, quality; at least a width, height or format). A space has ' +
        'at most 20.',
      inputSchema: toolSchema('asset_renditions_create', () =>
        z.object({
          name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
          ...renditionSpec,
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createAssetRendition(ctx, scopeOf(args), { name: args.name, ...specOf(args) }),
      );
    },
  );

  server.registerTool(
    'asset_renditions_update',
    {
      description:
        'Replace what a rendition preset does. Its URLs stay the same; the media cached under ' +
        'them is purged in the background.',
      inputSchema: toolSchema('asset_renditions_update', () =>
        z.object({ name: z.string(), ...renditionSpec, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await updateAssetRendition(ctx, scopeOf(args), args.name, specOf(args)));
    },
  );

  server.registerTool(
    'asset_renditions_delete',
    {
      description: 'Delete a rendition preset; its URLs answer 404 once their media is purged.',
      inputSchema: toolSchema('asset_renditions_delete', () =>
        z.object({ name: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      await deleteAssetRendition(ctx, scopeOf(args), args.name);
      return ok({ deleted: args.name });
    },
  );

  server.registerTool(
    'asset_set_metadata',
    {
      description:
        'Update an asset’s editorial metadata: localized alt text, focal point ' +
        '(x/y in 0..1 for smart cropping), taxonomy tag ids, and custom fields.',
      inputSchema: toolSchema('asset_set_metadata', () =>
        z.object({
          id: z.string(),
          // The REST body's shape: the two surfaces accept the same patches.
          ...assetMetadataPatchShape,
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await signedOne(
          scopeOf(args),
          await setAssetMetadata(ctx, scopeOf(args), args.id, {
            altText: args.altText,
            tags: args.tags,
            focalPoint: args.focalPoint,
            fields: args.fields,
          }),
        ),
      );
    },
  );
}
