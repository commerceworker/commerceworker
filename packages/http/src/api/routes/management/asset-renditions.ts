import {
  createAssetRendition,
  deleteAssetRendition,
  getAssetRendition,
  listAssetRenditions,
  updateAssetRendition,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as renditionDocs from '../../docs/schemas/asset-renditions';
import { assetRenditionBody, assetRenditionPatchBody, parseBody } from '../../validation';
import { BASE, scopeOf } from './shared';

export function assetRenditionsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- asset renditions ---------------------------------------------------
  // Named image presets of the space, served for every published image at …/r-<name>/….
  app.get(
    `${BASE}/asset-renditions`,
    doc('Assets', 'List rendition presets', {
      ok: renditionDocs.assetRenditionList,
      description: 'The space’s presets (the same in every environment), by name.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json({ items: await listAssetRenditions(ctx, scopeOf(c)) }),
  );
  app.post(
    `${BASE}/asset-renditions`,
    doc('Assets', 'Create a rendition preset', {
      body: assetRenditionBody,
      ok: renditionDocs.assetRendition,
      status: 201,
      description:
        'Every published image in the space is then also served at …/r-<name>/… on the media ' +
        'origin. A taken name is a 409; a space has at most 20.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await createAssetRendition(ctx, scopeOf(c), await parseBody(c, assetRenditionBody)),
        201,
      ),
  );
  app.get(
    `${BASE}/asset-renditions/:name`,
    doc('Assets', 'Get a rendition preset', { ok: renditionDocs.assetRendition }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getAssetRendition(ctx, scopeOf(c), c.req.param('name'))),
  );
  app.put(
    `${BASE}/asset-renditions/:name`,
    doc('Assets', 'Replace a rendition preset', {
      body: assetRenditionPatchBody,
      ok: renditionDocs.assetRendition,
      description:
        'Its URLs stay the same; the media cached under them is purged in the background.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await updateAssetRendition(
          ctx,
          scopeOf(c),
          c.req.param('name'),
          await parseBody(c, assetRenditionPatchBody),
        ),
      ),
  );
  app.delete(
    `${BASE}/asset-renditions/:name`,
    doc('Assets', 'Delete a rendition preset', {
      status: 204,
      description: 'Its URLs answer 404 once the media cached under them is purged.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      await deleteAssetRendition(ctx, scopeOf(c), c.req.param('name'));
      return c.body(null, 204);
    },
  );

  return app;
}
