import {
  assetBulkActionPublishes,
  auditActor,
  autoTagAsset,
  BULK_JOB_MAX_ITEMS,
  commitAssetFile,
  createVideoAsset,
  generateAltText,
  getAssetUsage,
  listAssetVersions,
  MAX_ASSET_BULK_TAGS,
  refreshVideoAsset,
  replaceAssetFile,
  restoreAssetVersion,
  setAssetRights,
  startAssetBulkJob,
  startMultipartAssetFileReplacement,
  transformAssetUrl,
} from '@commerceworker/application';
import { MAX_ASSET_RIGHTS_TEXT, NotConfiguredError, SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { assetVersionResponse } from '../../api/asset-response';
import { ok, rightsRefusal, scopeArgs, signedAssets, type ToolContext, toolSchema } from './shared';

export function registerAssetVersionTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { deps, ctx, ai, principal, guard } = t;
  const { signedOne } = signedAssets(deps);
  // --- asset versions, rights and bulk jobs ------------------------------------------------
  // The same use-cases and scopes as the REST routes: replacing or restoring a file is
  // content:write (Delivery keeps the published file until a republish), rights are
  // content:publish (they decide whether the asset is delivered).
  const fileBlob = () => {
    if (!deps.blob) throw new NotConfiguredError('blob', 'Replacing files needs a blob store');
    return deps.blob;
  };
  // The same author the REST routes record, so a version shows one name whichever surface made it.
  const actor = auditActor(principal);

  server.registerTool(
    'asset_replace_file',
    {
      description:
        'Start replacing an asset’s file: returns a signed PUT URL (upload.url, with ' +
        'upload.headers) for the next version and a commit object. PUT the bytes there, then ' +
        'call asset_commit_file with commit. Nothing changes until then; a published asset ' +
        'keeps delivering its published file until it is published again.',
      inputSchema: toolSchema('asset_replace_file', () =>
        z.object({
          id: z.string(),
          fileName: z.string().min(1).max(1024),
          contentType: z.string().min(1).max(256),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const replacement = await replaceAssetFile(ctx, fileBlob(), scopeOf(args), args.id, {
        fileName: args.fileName,
        contentType: args.contentType,
      });
      return ok({ ...replacement, asset: await signedOne(scopeOf(args), replacement.asset) });
    },
  );

  server.registerTool(
    'asset_replace_file_upload',
    {
      description:
        'Start replacing an asset’s file with a multipart upload, for a file past 100 MiB (up ' +
        'to the deployment’s cap). Then asset_upload_parts for part URLs, PUT each part ' +
        '(exactly its length), and asset_upload_complete with every part’s ETag: completing ' +
        'commits the new version (refused if another replace or restore committed first). ' +
        'asset_upload_abort gives up and keeps the file.',
      inputSchema: toolSchema('asset_replace_file_upload', () =>
        z.object({
          id: z.string(),
          fileName: z.string().min(1).max(1024),
          contentType: z.string().min(1).max(256),
          size: z.number().int().min(1),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const started = await startMultipartAssetFileReplacement(
        ctx,
        fileBlob(),
        scopeOf(args),
        args.id,
        { fileName: args.fileName, contentType: args.contentType, size: args.size },
      );
      return ok({ ...started, asset: await signedOne(scopeOf(args), started.asset) });
    },
  );

  server.registerTool(
    'asset_commit_file',
    {
      description:
        'Commit a replacement uploaded through asset_replace_file: the file becomes current as ' +
        'a new version, the old one is kept in the history, and ingest runs on it. Pass the ' +
        'commit object back unchanged. Refused when nothing was uploaded, or when another ' +
        'replace or restore committed first.',
      inputSchema: toolSchema('asset_commit_file', () =>
        z.object({
          id: z.string(),
          version: z.int().min(2),
          fileName: z.string().min(1).max(1024),
          contentType: z.string().min(1).max(256),
          attempt: z.string().min(1).max(64).optional().describe('commit.attempt, unchanged'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const asset = await commitAssetFile(
        ctx,
        fileBlob(),
        scopeOf(args),
        args.id,
        {
          version: args.version,
          fileName: args.fileName,
          contentType: args.contentType,
          ...(args.attempt ? { attempt: args.attempt } : {}),
        },
        { by: actor },
      );
      return ok(await signedOne(scopeOf(args), asset));
    },
  );

  server.registerTool(
    'asset_versions_list',
    {
      description:
        'List an asset’s file versions, newest first: the current file and every earlier one, ' +
        'with when each became the asset’s and which one Delivery serves (published).',
      inputSchema: toolSchema('asset_versions_list', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok({
        items: (
          await listAssetVersions(ctx, scopeOf(args), args.id, deps.blob ? { blob: deps.blob } : {})
        ).map(assetVersionResponse),
      });
    },
  );

  server.registerTool(
    'asset_restore_version',
    {
      description:
        'Make an earlier file version current again, as a new version pointing at the same ' +
        'bytes. Delivery keeps its published file until the asset is published again.',
      inputSchema: toolSchema('asset_restore_version', () =>
        z.object({ id: z.string(), version: z.int().min(1), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const asset = await restoreAssetVersion(
        ctx,
        deps.blob,
        scopeOf(args),
        args.id,
        args.version,
        { by: actor },
      );
      return ok(await signedOne(scopeOf(args), asset));
    },
  );

  server.registerTool(
    'asset_set_rights',
    {
      description:
        'Set an asset’s usage rights, replacing what it had (omit every field to clear them): ' +
        'license and credit (delivered with it), expiresAt (it is unpublished then) and ' +
        'embargoUntil (publishing is refused before then). Dates are ISO-8601 with a zone. On a ' +
        'published asset they apply at once; an embargo cannot be set on one.',
      inputSchema: toolSchema('asset_set_rights', () =>
        z.object({
          id: z.string(),
          license: z.string().max(MAX_ASSET_RIGHTS_TEXT).optional(),
          credit: z.string().max(MAX_ASSET_RIGHTS_TEXT).optional(),
          expiresAt: z.string().max(64).optional(),
          embargoUntil: z.string().max(64).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      const rights = {
        ...(args.license !== undefined ? { license: args.license } : {}),
        ...(args.credit !== undefined ? { credit: args.credit } : {}),
        ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
        ...(args.embargoUntil !== undefined ? { embargoUntil: args.embargoUntil } : {}),
      };
      return rightsRefusal(async () =>
        ok(
          await signedOne(scopeOf(args), await setAssetRights(ctx, scopeOf(args), args.id, rights)),
        ),
      );
    },
  );

  server.registerTool(
    'assets_bulk',
    {
      description:
        'Act on many assets as a resumable bulk job: move (folderId; null for the root), tag ' +
        '(addTags, removeTags), publish, unpublish or archive. Each asset gets the same checks ' +
        'as one at a time. Follow it with bulk_job_status; bulk_job_report names each asset that ' +
        'failed. move and tag need content:write; publish, unpublish and archive content:publish.',
      inputSchema: toolSchema('assets_bulk', () =>
        z.object({
          action: z.enum(['move', 'tag', 'publish', 'unpublish', 'archive']),
          ids: z.array(z.string().min(1).max(128)).min(1).max(BULK_JOB_MAX_ITEMS),
          folderId: z.string().min(1).max(128).nullable().optional(),
          addTags: z.array(z.string().min(1).max(128)).max(MAX_ASSET_BULK_TAGS).optional(),
          removeTags: z.array(z.string().min(1).max(128)).max(MAX_ASSET_BULK_TAGS).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(
        assetBulkActionPublishes(args.action) ? SCOPES.contentPublish : SCOPES.contentWrite,
        scopeOf(args),
      );
      return ok(
        await startAssetBulkJob(ctx, scopeOf(args), {
          action: args.action,
          ids: args.ids,
          ...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
          ...(args.addTags ? { addTags: args.addTags } : {}),
          ...(args.removeTags ? { removeTags: args.removeTags } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'asset_usage',
    {
      description: 'List the entries that reference an asset (where it is used).',
      inputSchema: toolSchema('asset_usage', () => z.object({ id: z.string(), ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getAssetUsage(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'asset_generate_alt_text',
    {
      description:
        'Suggest accessibility/SEO alt text for an image asset; set apply=true to ' +
        'write it to the asset metadata. Recorded in the agent cost ledger.',
      inputSchema: toolSchema('asset_generate_alt_text', () =>
        z.object({
          id: z.string(),
          locale: z.string().optional(),
          context: z.string().optional().describe('extra context about how the image is used'),
          apply: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await generateAltText(ctx, ai, scopeOf(args), args.id, {
          locale: args.locale,
          context: args.context,
          apply: args.apply,
        }),
      );
    },
  );

  server.registerTool(
    'asset_auto_tag',
    {
      description:
        'Suggest taxonomy tags for an image asset (matching the existing vocabulary ' +
        'and proposing new names); set apply=true to create + assign them.',
      inputSchema: toolSchema('asset_auto_tag', () =>
        z.object({ id: z.string(), apply: z.boolean().optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await autoTagAsset(ctx, ai, scopeOf(args), args.id, { apply: args.apply }));
    },
  );

  server.registerTool(
    'asset_transform_url',
    {
      description:
        'Build a transformed-image URL for an asset (resize/crop/format/quality), ' +
        'anchored to the stored focal point when cropping.',
      inputSchema: toolSchema('asset_transform_url', () =>
        z.object({
          id: z.string(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          fit: z.enum(['clip', 'crop', 'fill', 'max', 'scale']).optional(),
          format: z
            .enum(['auto', 'jpg', 'png', 'webp', 'avif'])
            .optional()
            .describe('auto negotiates AVIF/WebP per client'),
          quality: z.number().int().min(1).max(100).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      if (!deps.blob) throw new NotConfiguredError('blob', 'Transform URLs need a blob store');
      return ok(
        await transformAssetUrl(ctx, deps.blob, scopeOf(args), args.id, {
          width: args.width,
          height: args.height,
          fit: args.fit,
          format: args.format,
          quality: args.quality,
        }),
      );
    },
  );

  server.registerTool(
    'asset_video_create',
    {
      description:
        'Create a draft video asset and get a one-time direct upload URL on the video host ' +
        'at the edge. The client POSTs the file as multipart field `fileField` to ' +
        '`uploadUrl`; then call asset_video_refresh until file.video.status is ready.',
      inputSchema: toolSchema('asset_video_create', () =>
        z.object({
          fileName: z.string().min(1),
          contentType: z.string().describe('video/* MIME type'),
          title: z.record(z.string(), z.string()).optional().describe('locale -> title'),
          maxDurationSeconds: z.number().int().positive().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const created = await createVideoAsset(ctx, scopeOf(args), {
        fileName: args.fileName,
        contentType: args.contentType,
        title: args.title,
        maxDurationSeconds: args.maxDurationSeconds,
      });
      return ok({ ...created, asset: await signedOne(scopeOf(args), created.asset) });
    },
  );

  server.registerTool(
    'asset_video_refresh',
    {
      description:
        "Refresh a video asset's processing status, playback URLs (HLS/DASH) and poster from the video host.",
      inputSchema: toolSchema('asset_video_refresh', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await signedOne(scopeOf(args), await refreshVideoAsset(ctx, scopeOf(args), args.id)),
      );
    },
  );
}
