import {
  auditActor,
  getAssetZip,
  listAssetZips,
  requestAssetZip,
} from '@commerceworker/application';
import { MAX_ZIP_ASSETS, SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as zipDocs from '../../docs/schemas/asset-zips';
import { assetZipBody, parseBody } from '../../validation';
import { BASE, refuseGrantedAssetReads, scopeOf } from './shared';

export function assetZipsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob } = deps;
  const app = new Hono<AuthVars>();

  // --- zip downloads --------------------------------------------------------
  app.post(
    `${BASE}/asset-zips`,
    doc('Assets', 'Zip a selection of assets or a collection', {
      body: assetZipBody,
      ok: zipDocs.assetZip,
      status: 202,
      description:
        `A job (follow it at /asset-zips/{id}) that puts the assets’ current files in one zip ` +
        `(up to ${MAX_ZIP_ASSETS} assets, 20 GiB); once completed, its downloadUrl works for 15 ` +
        'minutes, and the archive is kept for a day.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      refuseGrantedAssetReads(c);
      const body = await parseBody(c, assetZipBody);
      return c.json(
        await requestAssetZip(ctx, scopeOf(c), body, {
          createdBy: auditActor(c.get('principal')),
        }),
        202,
      );
    },
  );
  app.get(
    `${BASE}/asset-zips`,
    doc('Assets', 'List recent zip downloads', { ok: zipDocs.assetZipList }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      refuseGrantedAssetReads(c);
      return c.json({ items: await listAssetZips(ctx, scopeOf(c)) });
    },
  );
  app.get(
    `${BASE}/asset-zips/:id`,
    doc('Assets', 'Get a zip download (with its download URL once built)', {
      ok: zipDocs.assetZip,
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      refuseGrantedAssetReads(c);
      return c.json(await getAssetZip(ctx, blob, scopeOf(c), c.req.param('id')));
    },
  );

  return app;
}
