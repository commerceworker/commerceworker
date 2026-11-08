import {
  createAssetFolder,
  deleteAssetFolder,
  listAssetFolders,
  updateAssetFolder,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as folderDocs from '../../docs/schemas/asset-folders';
import { assetFolderBody, assetFolderPatchBody, parseBody } from '../../validation';
import { BASE, scopeOf } from './shared';

export function assetFoldersRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- asset folders ------------------------------------------------------
  app.get(
    `${BASE}/asset-folders`,
    doc('Assets', 'List asset folders', {
      ok: folderDocs.assetFolderList,
      description: 'Every folder, in path order (a parent before its children).',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json({ items: await listAssetFolders(ctx, scopeOf(c)) }),
  );
  app.post(
    `${BASE}/asset-folders`,
    doc('Assets', 'Create an asset folder', {
      body: assetFolderBody,
      ok: folderDocs.assetFolder,
      status: 201,
      description: 'A sibling with the same name is a 409. Folders nest up to 16 deep.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, assetFolderBody);
      return c.json(await createAssetFolder(ctx, scopeOf(c), body), 201);
    },
  );
  app.patch(
    `${BASE}/asset-folders/:id`,
    doc('Assets', 'Rename or move an asset folder', {
      body: assetFolderPatchBody,
      ok: folderDocs.assetFolder,
      description:
        'A move takes the whole subtree along; never into the folder itself or below it. ' +
        'parentId null moves it to the root.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) =>
      c.json(
        await updateAssetFolder(
          ctx,
          scopeOf(c),
          c.req.param('id'),
          await parseBody(c, assetFolderPatchBody),
        ),
      ),
  );
  app.delete(
    `${BASE}/asset-folders/:id`,
    doc('Assets', 'Delete an empty asset folder', {
      status: 204,
      description: 'A folder with subfolders or assets in it is a 409: move them out first.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      await deleteAssetFolder(ctx, scopeOf(c), c.req.param('id'));
      return c.body(null, 204);
    },
  );

  return app;
}
