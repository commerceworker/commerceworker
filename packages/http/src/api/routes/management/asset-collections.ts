import {
  addToAssetCollection,
  auditActor,
  clampCount,
  createAssetCollection,
  deleteAssetCollection,
  getAssetCollection,
  listAssetCollectionItems,
  listAssetCollections,
  MAX_PAGE_LIMIT,
  removeFromAssetCollection,
  reorderAssetCollection,
  updateAssetCollection,
} from '@commerceworker/application';
import { MAX_COLLECTION_CHANGE, MAX_COLLECTION_ITEMS, SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as collectionDocs from '../../docs/schemas/asset-collections';
import * as assetDocs from '../../docs/schemas/assets';
import { parseAssetListQuery } from '../../query';
import {
  assetCollectionBody,
  assetCollectionPatchBody,
  collectionAssetIdsBody,
  collectionOrderBody,
  parseBody,
} from '../../validation';
import { assetUrls, BASE, refuseGrantedAssetReads, scopeOf } from './shared';

export function assetCollectionsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob } = deps;
  const { signed } = assetUrls(blob);
  const app = new Hono<AuthVars>();

  // --- asset collections ---------------------------------------------------
  app.get(
    `${BASE}/asset-collections`,
    doc('Assets', 'List asset collections', {
      ok: collectionDocs.assetCollectionPage,
      description: 'By name. Page with the response’s nextCursor.',
      query: {
        limit: `Page size, 1..${MAX_PAGE_LIMIT}`,
        cursor: 'nextCursor from the previous page',
      },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const limit = clampCount(c.req.query('limit'), MAX_PAGE_LIMIT, { min: 1 });
      const cursor = c.req.query('cursor');
      return c.json(
        await listAssetCollections(ctx, scopeOf(c), {
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      );
    },
  );
  app.post(
    `${BASE}/asset-collections`,
    doc('Assets', 'Create an asset collection', {
      body: assetCollectionBody,
      ok: collectionDocs.assetCollection,
      status: 201,
      description: 'A named, ordered set of assets; an asset may be in any number of them.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, assetCollectionBody);
      return c.json(
        await createAssetCollection(ctx, scopeOf(c), body, {
          createdBy: auditActor(c.get('principal')),
        }),
        201,
      );
    },
  );
  app.get(
    `${BASE}/asset-collections/:id`,
    doc('Assets', 'Get an asset collection', { ok: collectionDocs.assetCollection }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getAssetCollection(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.patch(
    `${BASE}/asset-collections/:id`,
    doc('Assets', 'Rename an asset collection or change its description', {
      body: assetCollectionPatchBody,
      ok: collectionDocs.assetCollection,
    }),
    requireScope(SCOPES.contentWrite),
    async (c) =>
      c.json(
        await updateAssetCollection(
          ctx,
          scopeOf(c),
          c.req.param('id'),
          await parseBody(c, assetCollectionPatchBody),
        ),
      ),
  );
  app.delete(
    `${BASE}/asset-collections/:id`,
    doc('Assets', 'Delete an asset collection', {
      status: 204,
      description: 'Its assets stay in the library; links shared to it stop opening.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      await deleteAssetCollection(ctx, scopeOf(c), c.req.param('id'));
      return c.body(null, 204);
    },
  );
  app.get(
    `${BASE}/asset-collections/:id/assets`,
    doc('Assets', 'List a collection’s assets, in its order', {
      ok: assetDocs.assetPage,
      description:
        'Filtered as the library is (archived members left out unless status asks). Page with ' +
        'nextCursor.',
      query: {
        kind: 'image | video | audio | document | other',
        mime: 'An exact content type (image/png) or a family (image/*)',
        tag: 'A taxonomy tag id',
        status: 'draft | published | archived | all',
        limit: `Page size, 1..${MAX_PAGE_LIMIT}`,
        cursor: 'nextCursor from the previous page',
      },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      refuseGrantedAssetReads(c);
      const page = await listAssetCollectionItems(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        parseAssetListQuery(c.req.query()),
      );
      return c.json({ ...page, items: await signed(c, page.items) });
    },
  );
  app.post(
    `${BASE}/asset-collections/:id/assets`,
    doc('Assets', 'Add assets to a collection', {
      body: collectionAssetIdsBody,
      ok: collectionDocs.collectionAdded,
      description:
        `After its last member, in the order given (up to ${MAX_COLLECTION_CHANGE} ids). A ` +
        `collection holds at most ${MAX_COLLECTION_ITEMS} assets: past that is a 409.`,
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const { assetIds } = await parseBody(c, collectionAssetIdsBody);
      return c.json(await addToAssetCollection(ctx, scopeOf(c), c.req.param('id'), assetIds));
    },
  );
  app.post(
    `${BASE}/asset-collections/:id/assets/remove`,
    doc('Assets', 'Remove assets from a collection', {
      body: collectionAssetIdsBody,
      ok: collectionDocs.collectionRemoved,
      description: 'They stay in the library. Ids that are not members are ignored.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const { assetIds } = await parseBody(c, collectionAssetIdsBody);
      return c.json(await removeFromAssetCollection(ctx, scopeOf(c), c.req.param('id'), assetIds));
    },
  );
  app.put(
    `${BASE}/asset-collections/:id/order`,
    doc('Assets', 'Reorder a collection', {
      body: collectionOrderBody,
      status: 204,
      description:
        'The named members go first, in that order; the rest follow in the order they had. ' +
        'Name every member to set the whole order.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const { assetIds } = await parseBody(c, collectionOrderBody);
      await reorderAssetCollection(ctx, scopeOf(c), c.req.param('id'), assetIds);
      return c.body(null, 204);
    },
  );

  return app;
}
