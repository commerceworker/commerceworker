import {
  abortMultipartAssetUpload,
  auditActor,
  completeMultipartAssetUpload,
  signAssetUploadParts,
  startMultipartAssetUpload,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as assetDocs from '../../docs/schemas/assets';
import * as uploadDocs from '../../docs/schemas/uploads';
import {
  completeUploadBody,
  multipartUploadBody,
  parseBody,
  uploadPartsBody,
} from '../../validation';
import { assetUrls, BASE, scopeOf } from './shared';

export function uploadsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob } = deps;
  const { signedOne } = assetUrls(blob);
  const app = new Hono<AuthVars>();

  // --- multipart uploads ----------------------------------------------------
  app.post(
    `${BASE}/assets/uploads`,
    doc('Assets', 'Create an asset with a multipart upload (large files)', {
      body: multipartUploadBody,
      ok: uploadDocs.multipartUpload,
      status: 201,
      description:
        'For a file past what one signed PUT takes (100 MiB). Sign part URLs at ' +
        '…/uploads/{uploadId}/parts, PUT each part (exactly its length), then complete with ' +
        'every part’s ETag. Abort to give up. 422 past the deployment’s cap ' +
        '(ASSET_UPLOAD_MAX_BYTES, 5 GiB by default).',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const { folderId, ...input } = await parseBody(c, multipartUploadBody);
      const started = await startMultipartAssetUpload(ctx, blob, scopeOf(c), input, {
        createdBy: auditActor(c.get('principal')),
        ...(folderId ? { folderId } : {}),
      });
      return c.json({ ...started, asset: await signedOne(c, started.asset) }, 201);
    },
  );
  app.post(
    `${BASE}/assets/:id/uploads/:uploadId/parts`,
    doc('Assets', 'Sign part URLs for a multipart upload', {
      body: uploadPartsBody,
      ok: uploadDocs.signedParts,
      description: 'Up to 100 parts per call; sign a part again to retry it.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const { partNumbers } = await parseBody(c, uploadPartsBody);
      return c.json(
        await signAssetUploadParts(
          ctx,
          blob,
          scopeOf(c),
          c.req.param('id'),
          c.req.param('uploadId'),
          partNumbers,
        ),
      );
    },
  );
  app.post(
    `${BASE}/assets/:id/uploads/:uploadId/complete`,
    doc('Assets', 'Complete a multipart upload', {
      body: completeUploadBody,
      ok: assetDocs.asset,
      description:
        'Name parts 1..n, each once, with its ETag. Ingest then starts. For a replacement ' +
        '(…/file/uploads), completing commits the new version; 409 when another replace or ' +
        'restore took that version first (the upload is dropped).',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const { parts } = await parseBody(c, completeUploadBody);
      const asset = await completeMultipartAssetUpload(
        ctx,
        { blob, ...(deps.assetIngest ? { ingest: deps.assetIngest } : {}) },
        scopeOf(c),
        c.req.param('id'),
        c.req.param('uploadId'),
        parts,
        { by: auditActor(c.get('principal')) },
      );
      return c.json(await signedOne(c, asset));
    },
  );
  app.delete(
    `${BASE}/assets/:id/uploads/:uploadId`,
    doc('Assets', 'Abort a multipart upload', {
      status: 204,
      description: 'Its parts are discarded, and its draft deleted while it has no bytes.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      await abortMultipartAssetUpload(
        ctx,
        blob,
        scopeOf(c),
        c.req.param('id'),
        c.req.param('uploadId'),
      );
      return c.body(null, 204);
    },
  );

  return app;
}
