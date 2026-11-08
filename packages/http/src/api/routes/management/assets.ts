import {
  type AssetBulkAction,
  assetBulkActionPublishes,
  assetSearchDeps,
  auditActor,
  createAsset,
  createVideoAsset,
  listAssets,
  MAX_PAGE_LIMIT,
  moveAssets,
  searchAssets,
  startAssetBulkJob,
  startAssetReindex,
} from '@commerceworker/application';
import { authorize, NotConfiguredError, SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as folderDocs from '../../docs/schemas/asset-folders';
import * as assetDocs from '../../docs/schemas/assets';
import { parseAssetListQuery, parseAssetSearchQuery } from '../../query';
import {
  assetBulkBody,
  assetReindexBody,
  createAssetBody,
  createVideoAssetBody,
  moveAssetsBody,
  parseBody,
} from '../../validation';
import { actingCtx, assetUrls, BASE, scopeOf } from './shared';

export function assetsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob, rag } = deps;
  const { signedOne, signed } = assetUrls(blob);
  const app = new Hono<AuthVars>();

  // --- assets -------------------------------------------------------------
  app.get(
    `${BASE}/assets`,
    doc('Assets', 'List the asset library (filtered, sorted, cursor-paged)', {
      ok: assetDocs.assetPage,
      description:
        'Archived assets are left out unless status=archived or status=all. Page with the ' +
        "response's nextCursor; a cursor is valid only with the same filters and sort.",
      query: {
        kind: 'image | video | audio | document | other',
        mime: 'An exact content type (image/png) or a family (image/*)',
        tag: 'A taxonomy tag id',
        folder: 'A folder id, or root for assets in no folder',
        status: 'draft | published | archived | all',
        sort: 'updatedAt (default) | createdAt | size',
        order: 'desc (default) | asc',
        limit: `Page size, 1..${MAX_PAGE_LIMIT}`,
        cursor: 'nextCursor from the previous page',
      },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const page = await listAssets(ctx, scopeOf(c), parseAssetListQuery(c.req.query()));
      return c.json({ ...page, items: await signed(c, page.items) });
    },
  );
  app.get(
    `${BASE}/assets/search`,
    doc('Assets', 'Search the asset library (hybrid, with facets)', {
      ok: assetDocs.assetSearchPage,
      description:
        'Full text (file name, title, caption, alt text, tag names, text read from documents and ' +
        'recordings) and semantic similarity, fused by rank. Drafts and published alike; ' +
        'archived left out unless status asks. facets counts matches by kind, tag and folder, ' +
        'each without its own filter.',
      query: {
        q: 'Search text (1–256 characters)',
        kind: 'image | video | audio | document | other',
        tag: 'A taxonomy tag id',
        folder: 'A folder id, or root for assets in no folder',
        status: 'draft | published | archived | all',
        limit: 'Most results, 1..100 (default 20)',
      },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const page = await searchAssets(
        ctx,
        deps.assetSearch ?? assetSearchDeps(rag),
        scopeOf(c),
        parseAssetSearchQuery(c.req.query()),
      );
      return c.json({ ...page, items: await signed(c, page.items) });
    },
  );
  app.post(
    `${BASE}/assets/reindex`,
    doc('Assets', 'Send the asset library through ingest', {
      body: assetReindexBody,
      ok: assetDocs.assetReindex,
      status: 202,
      description:
        'A resumable bulk job (follow it at /bulk/jobs/{id}) that re-runs ingest — hash, ' +
        'duplicates, dimensions, alt text and tags where empty, text extraction, search index — ' +
        'on assets never ingested (uploaded before ingest) or whose ingest failed; all: true ' +
        'takes every asset with a file. Hosted videos are left out. While a reindex is running ' +
        'in the environment, that job is returned instead (running: true). 501 when the ingest ' +
        'queue is not bound.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      if (!deps.assetIngest) {
        throw new NotConfiguredError('asset ingest', 'Bind ASSET_EVENTS_QUEUE to reindex assets');
      }
      const { all } = await parseBody(c, assetReindexBody);
      return c.json(await startAssetReindex(ctx, scopeOf(c), { all: all === true }), 202);
    },
  );
  app.post(
    `${BASE}/assets`,
    doc('Assets', 'Create an asset (presigned direct upload)', {
      body: createAssetBody,
      ok: assetDocs.uploadTicket,
      status: 201,
      description: 'PUT the file bytes to upload.url with upload.headers, then publish the asset.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const { folderId, ...input } = await parseBody(c, createAssetBody);
      const created = await createAsset(ctx, blob, scopeOf(c), input, {
        createdBy: auditActor(c.get('principal')),
        ...(folderId ? { folderId } : {}),
      });
      return c.json({ ...created, asset: await signedOne(c, created.asset) }, 201);
    },
  );
  app.post(
    `${BASE}/assets/move`,
    doc('Assets', 'File assets in a folder', {
      body: moveAssetsBody,
      ok: folderDocs.assetMoved,
      description:
        'One statement whatever the count (up to 500 ids). folderId null takes them to the root. ' +
        'Ids that are not assets here are skipped; an unknown folder is a 404.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => c.json(await moveAssets(ctx, scopeOf(c), await parseBody(c, moveAssetsBody))),
  );
  app.post(
    `${BASE}/assets/bulk`,
    doc('Assets', 'Act on many assets as a bulk job', {
      body: assetBulkBody,
      ok: assetDocs.assetBulkJob,
      status: 202,
      description:
        'A resumable bulk job over a selection of assets (follow it at /bulk/jobs/{id}, failures ' +
        'at /bulk/jobs/{id}/report, each named by the asset’s title or file name): move ' +
        '(folderId, null for the root), tag (addTags, removeTags), publish, unpublish or ' +
        'archive. Each asset goes through the same checks as one at a time (publishing refuses ' +
        'an archived or embargoed asset). move and tag need content:write; publish, unpublish ' +
        'and archive need content:publish.',
    }),
    // No route-level scope: it depends on the action, so it is checked once the body is read.
    // content:publish alone is enough to publish, as on the single-asset routes and MCP.
    async (c) => {
      const body = await parseBody(c, assetBulkBody);
      const action = body.action as AssetBulkAction;
      authorize(
        c.get('principal'),
        assetBulkActionPublishes(action) ? SCOPES.contentPublish : SCOPES.contentWrite,
        c.req.param('space'),
      );
      const job = await startAssetBulkJob(actingCtx(ctx, c), scopeOf(c), {
        action,
        ids: body.ids,
        ...(body.folderId !== undefined ? { folderId: body.folderId } : {}),
        ...(body.addTags ? { addTags: body.addTags } : {}),
        ...(body.removeTags ? { removeTags: body.removeTags } : {}),
      });
      return c.json(job, 202);
    },
  );
  app.post(
    `${BASE}/assets/videos`,
    doc('Assets', 'Create a video asset (direct upload to the video host)', {
      body: createVideoAssetBody,
      ok: assetDocs.videoUploadTicket,
      status: 201,
      description:
        'POST the file as multipart field upload.fileField to upload.uploadUrl, then poll ' +
        '/assets/{id}/video/refresh (or rely on the host webhook) until file.video.status is ready. ' +
        '501 when no video host is bound.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const created = await createVideoAsset(
        ctx,
        scopeOf(c),
        await parseBody(c, createVideoAssetBody),
      );
      return c.json({ ...created, asset: await signedOne(c, created.asset) }, 201);
    },
  );

  return app;
}
