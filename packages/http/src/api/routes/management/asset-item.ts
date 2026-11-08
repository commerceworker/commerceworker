import {
  archiveAsset,
  auditActor,
  autoTagAsset,
  commitAssetFile,
  deleteAsset,
  generateAltText,
  getAsset,
  getAssetUsage,
  listAssetVersions,
  parseImageTransform,
  publishAsset,
  refreshVideoAsset,
  reingestAsset,
  replaceAssetFile,
  restoreAsset,
  restoreAssetVersion,
  setAssetMetadata,
  setAssetRights,
  startMultipartAssetFileReplacement,
  transformAssetUrl,
  unpublishAsset,
} from '@commerceworker/application';
import { NotConfiguredError, SCOPES, ValidationError } from '@commerceworker/domain';
import { Hono } from 'hono';
import { assetVersionResponse } from '../../asset-response';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as assetDocs from '../../docs/schemas/assets';
import * as uploadDocs from '../../docs/schemas/uploads';
import {
  altTextBody,
  assetMetadataBody,
  assetRightsBody,
  commitAssetFileBody,
  parseBody,
  replaceAssetFileBody,
  replaceAssetFileUploadBody,
  tierOnlyBody,
} from '../../validation';
import { assetUrls, BASE, scopeOf } from './shared';

export function assetItemRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob, ai } = deps;
  const { signedOne } = assetUrls(blob);
  const app = new Hono<AuthVars>();

  // --- one asset (read, edit, AI, publishing, file versions, rights) ----------
  app.get(
    `${BASE}/assets/:id`,
    doc('Assets', 'Get an asset', {
      ok: assetDocs.asset,
      description:
        'Its draft state, with file.url a short-lived signed read URL (a hosted video’s ' +
        'playback URLs are in file.video).',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await signedOne(c, await getAsset(ctx, scopeOf(c), c.req.param('id')))),
  );
  app.post(
    `${BASE}/assets/:id/video/refresh`,
    doc('Assets', "Refresh a video asset's processing status from the video host", {
      ok: assetDocs.asset,
    }),
    requireScope(SCOPES.contentWrite),
    async (c) =>
      c.json(await signedOne(c, await refreshVideoAsset(ctx, scopeOf(c), c.req.param('id')))),
  );
  app.post(
    `${BASE}/assets/:id/reingest`,
    doc('Assets', "Run ingest on an asset's file again", {
      ok: assetDocs.asset,
      status: 202,
      description:
        'Queues a fresh ingest run on the current file (a retry after ingestStatus error, or ' +
        'after the AI or extraction setup changed). Alt text and tags are still only filled ' +
        'where empty. 501 when the ingest queue is not bound; 400 for a hosted video.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      if (!deps.assetIngest) {
        throw new NotConfiguredError('asset ingest', 'Bind ASSET_EVENTS_QUEUE to re-run ingest');
      }
      const asset = await reingestAsset(ctx, deps.assetIngest, scopeOf(c), c.req.param('id'));
      return c.json(await signedOne(c, asset), 202);
    },
  );
  app.patch(
    `${BASE}/assets/:id/metadata`,
    doc('Assets', "Edit an asset's metadata", {
      body: assetMetadataBody,
      ok: assetDocs.asset,
      description:
        'Only the keys sent change: altText (per locale), tags (tag ids), focalPoint (x and y, ' +
        'each 0..1) and fields. A value the save changes stops being an AI suggestion; one sent ' +
        'back unchanged stays one. This edits the ' +
        'draft; publish again to carry it into Delivery.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) =>
      c.json(
        await signedOne(
          c,
          await setAssetMetadata(
            ctx,
            scopeOf(c),
            c.req.param('id'),
            await parseBody(c, assetMetadataBody),
          ),
        ),
      ),
  );
  app.get(
    `${BASE}/assets/:id/usage`,
    doc('Assets', 'List the entries that link to an asset', {
      ok: assetDocs.assetUsage,
      description: 'Each entry field that links to it, from the reverse-reference index.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json({ items: await getAssetUsage(ctx, scopeOf(c), c.req.param('id')) }),
  );
  app.get(
    `${BASE}/assets/:id/transform`,
    doc('Assets', 'Get a resized or re-encoded image URL', {
      ok: assetDocs.transformedImage,
      description:
        'Built from a fresh signed read URL for the current file version (it expires with that ' +
        'URL, 15 minutes), through the image service when one is bound (for published images, ' +
        'prefer the delivered asset’s srcset and renditions). fit=crop is anchored to the focal ' +
        'point. Images only (422 otherwise).',
      query: {
        w: 'Width, 1..10000',
        h: 'Height, 1..10000',
        fit: 'clip | crop | fill | max | scale',
        fm: 'auto | jpg | png | webp | avif',
        q: 'Quality, 1..100',
      },
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json(
        await transformAssetUrl(
          ctx,
          blob,
          scopeOf(c),
          c.req.param('id'),
          parseImageTransform(c.req.query()),
        ),
      ),
  );
  // Tagged with the other model-backed operations, as the inventory classified them before.
  app.post(
    `${BASE}/assets/:id/alt-text`,
    doc('AI & agents', 'Suggest alt text for an image asset', {
      body: altTextBody,
      ok: assetDocs.altTextResult,
      description:
        'From the file name, title, description and context (not the pixels). apply: true saves ' +
        'it on the metadata as well. Counted against the space’s AI budget (429 once spent); 422 ' +
        'for an asset that is not an image.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) =>
      c.json(
        await generateAltText(
          ctx,
          ai,
          scopeOf(c),
          c.req.param('id'),
          await parseBody(c, altTextBody),
        ),
      ),
  );
  app.post(
    `${BASE}/assets/:id/auto-tag`,
    doc('AI & agents', 'Suggest tags for an image asset', {
      body: tierOnlyBody,
      ok: assetDocs.autoTagResult,
      description:
        'Existing tags the model chose (tagIds) and new names it suggests (newTags). apply: true ' +
        'creates the new tags and sets them all on the asset. Counted against the AI budget; 422 ' +
        'for an asset that is not an image.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) =>
      c.json(
        await autoTagAsset(
          ctx,
          ai,
          scopeOf(c),
          c.req.param('id'),
          await parseBody(c, tierOnlyBody),
        ),
      ),
  );
  app.post(
    `${BASE}/assets/:id/published`,
    doc('Assets', 'Publish an asset', {
      ok: assetDocs.asset,
      description:
        'Delivery serves its current file and metadata from then on. 409 asset_embargoed before ' +
        'its embargo lifts (error.embargoUntil) and asset_expired after its rights expired ' +
        '(error.expiresAt); 400 for an archived asset.',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => c.json(await signedOne(c, await publishAsset(ctx, scopeOf(c), c.req.param('id')))),
  );
  app.delete(
    `${BASE}/assets/:id/published`,
    doc('Assets', 'Unpublish an asset', {
      ok: assetDocs.asset,
      description: 'Takes it out of Delivery; it stays a draft. 400 when it is not published.',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) =>
      c.json(await signedOne(c, await unpublishAsset(ctx, scopeOf(c), c.req.param('id')))),
  );
  app.post(
    `${BASE}/assets/:id/archive`,
    doc('Assets', 'Archive an asset', {
      ok: assetDocs.asset,
      description:
        'Takes it out of Delivery at once when published, and out of the default listing. ' +
        'Idempotent. Requires content:publish, as unpublishing does.',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => c.json(await signedOne(c, await archiveAsset(ctx, scopeOf(c), c.req.param('id')))),
  );
  app.post(
    `${BASE}/assets/:id/restore`,
    doc('Assets', 'Restore an archived asset', {
      ok: assetDocs.asset,
      description: 'Comes back as a draft; publishing it again is a separate action. Idempotent.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => c.json(await signedOne(c, await restoreAsset(ctx, scopeOf(c), c.req.param('id')))),
  );
  app.post(
    `${BASE}/assets/:id/file`,
    doc('Assets', "Start replacing an asset's file", {
      body: replaceAssetFileBody,
      ok: assetDocs.assetFileReplacement,
      status: 201,
      description:
        'Returns a signed PUT for the next version (up to 100 MiB; past that, ' +
        '/assets/{id}/file/uploads). PUT the bytes to upload.url with upload.headers, then POST ' +
        'commit to /assets/{id}/file/commit. Nothing changes until then. The URL stores once: a ' +
        'second PUT through it is 412. A published asset keeps delivering its published file ' +
        'until it is published again. 400 for a hosted video.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const replacement = await replaceAssetFile(
        ctx,
        blob,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, replaceAssetFileBody),
      );
      return c.json({ ...replacement, asset: await signedOne(c, replacement.asset) }, 201);
    },
  );
  app.post(
    `${BASE}/assets/:id/file/uploads`,
    doc('Assets', "Start replacing an asset's file with a multipart upload (large files)", {
      body: replaceAssetFileUploadBody,
      ok: uploadDocs.multipartReplacement,
      status: 201,
      description:
        'For a replacement past one signed PUT (100 MiB). Sign part URLs at ' +
        '/assets/{id}/uploads/{uploadId}/parts, PUT each part, then complete it there: that ' +
        'commits the new version. Abort to give up (the asset keeps its file). Replaces started ' +
        'side by side each upload to their own key: the first to commit wins, the others get ' +
        '409. 422 past the deployment’s cap.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const started = await startMultipartAssetFileReplacement(
        ctx,
        blob,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, replaceAssetFileUploadBody),
      );
      return c.json({ ...started, asset: await signedOne(c, started.asset) }, 201);
    },
  );
  app.post(
    `${BASE}/assets/:id/file/commit`,
    doc('Assets', 'Commit an uploaded replacement file', {
      body: commitAssetFileBody,
      ok: assetDocs.asset,
      description:
        'Makes the uploaded file current as a new version and keeps the old one in the ' +
        'history; ingest runs on it. 422 when nothing was uploaded; 409 when another replace or ' +
        'restore committed first. Committing again what is already committed returns the asset.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) =>
      c.json(
        await signedOne(
          c,
          await commitAssetFile(
            ctx,
            blob,
            scopeOf(c),
            c.req.param('id'),
            await parseBody(c, commitAssetFileBody),
            { by: auditActor(c.get('principal')) },
          ),
        ),
      ),
  );
  app.get(
    `${BASE}/assets/:id/versions`,
    doc('Assets', "List an asset's file versions", {
      ok: assetDocs.assetVersionList,
      description:
        'Newest first: the current file and every earlier one, each with when it became the ' +
        'asset’s and by whom, and which one Delivery serves (published).',
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json({
        items: (await listAssetVersions(ctx, scopeOf(c), c.req.param('id'), { blob })).map(
          assetVersionResponse,
        ),
      }),
  );
  app.post(
    `${BASE}/assets/:id/versions/:version/restore`,
    doc('Assets', 'Restore an earlier file version', {
      ok: assetDocs.asset,
      description:
        'Makes that version’s file current again as a new version (the bytes are not copied). ' +
        'Delivery keeps its published file until the asset is published again. 422 for the ' +
        'current version; 404 for one the asset never had.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const version = Number(c.req.param('version'));
      if (!Number.isInteger(version) || version < 1) {
        throw new ValidationError([{ field: 'version', message: 'A version number (1 or more)' }]);
      }
      const asset = await restoreAssetVersion(ctx, blob, scopeOf(c), c.req.param('id'), version, {
        by: auditActor(c.get('principal')),
      });
      return c.json(await signedOne(c, asset));
    },
  );
  app.put(
    `${BASE}/assets/:id/rights`,
    doc('Assets', "Set an asset's usage rights", {
      body: assetRightsBody,
      ok: assetDocs.asset,
      description:
        'Replaces the rights (an empty body clears them): license and credit (Delivery shows ' +
        'both), expiresAt (the asset is unpublished then, and its media answers 410) and ' +
        'embargoUntil (publishing is refused before then with 409 asset_embargoed). On a ' +
        'published asset they apply at once, without a republish; an embargo cannot be set on ' +
        'one. Requires content:publish: rights decide whether the asset is delivered.',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const body = await parseBody(c, assetRightsBody);
      const rights = Object.fromEntries(
        Object.entries(body).filter(([, v]) => v !== null && v !== undefined),
      );
      return c.json(
        await signedOne(c, await setAssetRights(ctx, scopeOf(c), c.req.param('id'), rights)),
      );
    },
  );
  app.delete(
    `${BASE}/assets/:id`,
    doc('Assets', 'Delete an asset permanently', {
      status: 204,
      description:
        'Irreversible, so only an archived asset can be deleted: anything else is refused with 400 ' +
        'invalid_state. Refuses with 409 asset_in_use while entries, drafts included, link to it: ' +
        "error.usage lists the first 50 links, each with the entry's contentTypeApiId " +
        'and entryTitle, and error.total counts them all. Its files are removed in the background. ' +
        'Requires content:publish, as deleting an entry permanently does.',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      await deleteAsset(ctx, scopeOf(c), c.req.param('id'));
      return c.body(null, 204);
    },
  );

  return app;
}
