import {
  type AssetCollection,
  assetCollectionDescription,
  assetCollectionName,
  ConflictError,
  collectionChangeIds,
  type DeliveredAsset,
  MAX_COLLECTION_ITEMS,
  NotFoundError,
  type Scope,
} from '@commerceworker/domain';
import {
  type AssetCollectionPage,
  type AssetListQuery,
  type AssetPage,
  type ContentStoreTx,
  TransactionConflictError,
} from '@commerceworker/ports';
import {
  type AssetReadOptions,
  assetProjectionContext,
  projectPublishedAsset,
} from './asset-delivery';
import type { AppContext } from './context';

/**
 * Collections: named, curated, ordered sets of assets. An asset may be in any number of them
 * (folders file it in one place). Every change commits with an `asset_collection.changed` event in
 * the same unit: the engine purges what Delivery lists for the collection and every share page
 * that shows it.
 */

async function collectionOrThrow(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<AssetCollection> {
  const collection = await ctx.store.assetCollections.get(scope, id);
  if (!collection) throw new NotFoundError('AssetCollection', id);
  return collection;
}

/** Runs a change, reporting a collection deleted before it committed as the check would have. */
async function gone(id: string, change: () => Promise<void>): Promise<void> {
  try {
    await change();
  } catch (err) {
    if (err instanceof TransactionConflictError) throw new NotFoundError('AssetCollection', id);
    throw err;
  }
}

/** The event every change rides with. */
async function announce(ctx: AppContext, tx: ContentStoreTx, scope: Scope, id: string) {
  await tx.outbox.append({
    id: ctx.ids.newId(),
    type: 'asset_collection.changed',
    scope,
    occurredAt: ctx.clock.now().toISOString(),
    collectionId: id,
  });
}

export async function listAssetCollections(
  ctx: AppContext,
  scope: Scope,
  query: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<AssetCollectionPage> {
  return ctx.store.assetCollections.list(scope, query);
}

export async function getAssetCollection(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<AssetCollection> {
  return collectionOrThrow(ctx, scope, id);
}

export async function createAssetCollection(
  ctx: AppContext,
  scope: Scope,
  input: { readonly name: string; readonly description?: string },
  opts: { readonly createdBy?: string } = {},
): Promise<AssetCollection> {
  const now = ctx.clock.now().toISOString();
  const description =
    input.description !== undefined ? assetCollectionDescription(input.description) : undefined;
  const collection: AssetCollection = {
    id: ctx.ids.newId(),
    name: assetCollectionName(input.name),
    ...(description ? { description } : {}),
    itemCount: 0,
    createdAt: now,
    ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
    updatedAt: now,
  };
  await ctx.store.withTransaction(async (tx) => {
    await tx.assetCollections.create(scope, collection);
    await announce(ctx, tx, scope, collection.id);
  });
  return collection;
}

/** Renames a collection and/or changes its description (`''` clears it). */
export async function updateAssetCollection(
  ctx: AppContext,
  scope: Scope,
  id: string,
  patch: { readonly name?: string; readonly description?: string },
): Promise<AssetCollection> {
  const current = await collectionOrThrow(ctx, scope, id);
  const { description: _old, ...rest } = current;
  const description =
    patch.description === undefined
      ? current.description
      : assetCollectionDescription(patch.description);
  const updated: AssetCollection = {
    ...rest,
    name: patch.name === undefined ? current.name : assetCollectionName(patch.name),
    ...(description ? { description } : {}),
    updatedAt: ctx.clock.now().toISOString(),
  };
  await gone(id, () =>
    ctx.store.withTransaction(async (tx) => {
      await tx.assetCollections.save(scope, updated);
      await announce(ctx, tx, scope, id);
    }),
  );
  return updated;
}

/** Deletes a collection and its memberships; the assets stay where they are. */
export async function deleteAssetCollection(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<void> {
  await collectionOrThrow(ctx, scope, id);
  await ctx.store.withTransaction(async (tx) => {
    await tx.assetCollections.delete(scope, id);
    await announce(ctx, tx, scope, id);
  });
}

/**
 * Adds assets after the collection's last member, in the order given. Assets already in it stay
 * where they are, and ids that aren't assets here are skipped (named in `skipped`). A collection
 * holds at most {@link MAX_COLLECTION_ITEMS}; an add past it is refused whole (409), even when a
 * concurrent add is what filled it.
 */
export async function addToAssetCollection(
  ctx: AppContext,
  scope: Scope,
  id: string,
  assetIds: readonly string[],
): Promise<{ readonly added: number; readonly skipped: readonly string[] }> {
  const ids = collectionChangeIds(assetIds);
  const [collection, members, found] = await Promise.all([
    collectionOrThrow(ctx, scope, id),
    ctx.store.assetCollections.listItemIds(scope, id),
    ctx.store.assets.getMany(scope, ids),
  ]);
  const present = new Set(members);
  const exists = new Set(found.map((a) => a.id));
  const adding = ids.filter((a) => exists.has(a) && !present.has(a));
  const full = () => new ConflictError(`A collection holds at most ${MAX_COLLECTION_ITEMS} assets`);
  if (collection.itemCount + adding.length > MAX_COLLECTION_ITEMS) throw full();
  if (adding.length > 0) {
    try {
      await ctx.store.withTransaction(async (tx) => {
        await tx.assetCollections.addItems(
          scope,
          id,
          adding,
          ctx.clock.now(),
          MAX_COLLECTION_ITEMS,
        );
        await announce(ctx, tx, scope, id);
      });
    } catch (err) {
      if (err instanceof TransactionConflictError) {
        // Deleted, or filled by another add, since the check.
        if (!(await ctx.store.assetCollections.get(scope, id))) {
          throw new NotFoundError('AssetCollection', id);
        }
        throw full();
      }
      throw err;
    }
  }
  return { added: adding.length, skipped: ids.filter((a) => !exists.has(a)) };
}

/** Takes assets out of a collection (never out of the library). Ids not in it are ignored. */
export async function removeFromAssetCollection(
  ctx: AppContext,
  scope: Scope,
  id: string,
  assetIds: readonly string[],
): Promise<{ readonly removed: number }> {
  const ids = collectionChangeIds(assetIds);
  await collectionOrThrow(ctx, scope, id);
  const members = new Set(await ctx.store.assetCollections.listItemIds(scope, id));
  const removing = ids.filter((a) => members.has(a));
  if (removing.length > 0) {
    await ctx.store.withTransaction(async (tx) => {
      await tx.assetCollections.removeItems(scope, id, removing);
      await announce(ctx, tx, scope, id);
    });
  }
  return { removed: removing.length };
}

/**
 * Puts the named members first, in that order; the rest follow in the order they had. To set the
 * whole order, name every member. Ids that aren't members are ignored.
 */
export async function reorderAssetCollection(
  ctx: AppContext,
  scope: Scope,
  id: string,
  assetIds: readonly string[],
): Promise<void> {
  // A whole collection's order at most: still one JSON parameter.
  const ids = collectionChangeIds(assetIds, MAX_COLLECTION_ITEMS);
  await collectionOrThrow(ctx, scope, id);
  await gone(id, () =>
    ctx.store.withTransaction(async (tx) => {
      await tx.assetCollections.reorder(scope, id, ids);
      await announce(ctx, tx, scope, id);
    }),
  );
}

/** A page of a collection's assets, in its order, filtered as the library is. */
export async function listAssetCollectionItems(
  ctx: AppContext,
  scope: Scope,
  id: string,
  query: AssetListQuery = {},
): Promise<AssetPage> {
  await collectionOrThrow(ctx, scope, id);
  return ctx.store.assetCollections.listItems(scope, id, query);
}

/** A collection as Delivery serves it: its name and its published members, projected. */
export interface DeliveredCollection {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly items: DeliveredAsset[];
  readonly nextCursor?: string;
}

/**
 * Delivery's `GET …/collections/:id`: the collection's published members in its order, in the
 * delivered asset shape (drafts and archived members never appear). Read only.
 */
export async function getDeliveredCollection(
  ctx: AppContext,
  scope: Scope,
  id: string,
  query: { readonly limit?: number; readonly cursor?: string } = {},
  opts: AssetReadOptions = {},
): Promise<DeliveredCollection> {
  const [collection, page, pc] = await Promise.all([
    collectionOrThrow(ctx, scope, id),
    ctx.store.assetCollections.listPublishedItems(scope, id, query),
    assetProjectionContext(ctx, scope, opts),
  ]);
  return {
    id: collection.id,
    name: collection.name,
    ...(collection.description ? { description: collection.description } : {}),
    items: page.items.map((s) => projectPublishedAsset(ctx, scope, s, pc)),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}
