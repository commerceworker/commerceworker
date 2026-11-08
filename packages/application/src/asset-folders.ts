import {
  type AssetFolder,
  assertFolderMove,
  assetFolderName,
  assetFolderPath,
  ConflictError,
  MAX_ASSET_FOLDER_DEPTH,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import type { AppContext } from './context';

/** How deep a materialized path is: `/a/` is 1, `/a/b/` is 2. */
const depthOf = (path: string): number => path.split('/').length - 2;

/** Every folder in the asset library, a parent before its children (path order). */
export async function listAssetFolders(ctx: AppContext, scope: Scope): Promise<AssetFolder[]> {
  return ctx.store.assetFolders.list(scope);
}

async function folderOrThrow(ctx: AppContext, scope: Scope, id: string): Promise<AssetFolder> {
  const folder = await ctx.store.assetFolders.get(scope, id);
  if (!folder) throw new NotFoundError('AssetFolder', id);
  return folder;
}

/** Creates a folder at the root or inside `parentId`. A sibling of the same name is a 409. */
export async function createAssetFolder(
  ctx: AppContext,
  scope: Scope,
  input: { readonly name: string; readonly parentId?: string | null },
): Promise<AssetFolder> {
  const name = assetFolderName(input.name);
  const parent = input.parentId ? await folderOrThrow(ctx, scope, input.parentId) : null;
  const id = ctx.ids.newId();
  const now = ctx.clock.now().toISOString();
  const folder: AssetFolder = {
    id,
    name,
    ...(parent ? { parentId: parent.id } : {}),
    path: assetFolderPath(parent, id),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await ctx.store.assetFolders.create(scope, folder);
  } catch (err) {
    // The parent was deleted after the check: report it like the check would have.
    if (err instanceof TransactionConflictError && parent) {
      throw new NotFoundError('AssetFolder', parent.id);
    }
    throw err;
  }
  return folder;
}

/**
 * Renames a folder and/or moves it (`parentId: null` to the root). A move takes the whole subtree
 * along, and never into the folder itself or anything inside it.
 */
export async function updateAssetFolder(
  ctx: AppContext,
  scope: Scope,
  id: string,
  patch: { readonly name?: string; readonly parentId?: string | null },
): Promise<AssetFolder> {
  const folder = await folderOrThrow(ctx, scope, id);
  const name = patch.name === undefined ? folder.name : assetFolderName(patch.name);
  let parent: AssetFolder | null = null;
  let path = folder.path;
  let parentId = folder.parentId;
  if (patch.parentId !== undefined && (patch.parentId ?? undefined) !== folder.parentId) {
    parent = patch.parentId ? await folderOrThrow(ctx, scope, patch.parentId) : null;
    assertFolderMove(folder, parent);
    path = assetFolderPath(parent, folder.id);
    parentId = parent?.id;
    // The subtree moves along, so the depth limit applies to its deepest folder.
    const below = (await ctx.store.assetFolders.list(scope))
      .filter((f) => f.path.startsWith(folder.path))
      .reduce((max, f) => Math.max(max, depthOf(f.path) - depthOf(folder.path)), 0);
    if (depthOf(path) + below > MAX_ASSET_FOLDER_DEPTH) {
      throw new ValidationError([
        { field: 'parentId', message: `Folders nest at most ${MAX_ASSET_FOLDER_DEPTH} deep` },
      ]);
    }
  }
  const { parentId: _old, ...rest } = folder;
  const updated: AssetFolder = {
    ...rest,
    name,
    ...(parentId ? { parentId } : {}),
    path,
    updatedAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.assetFolders.save(scope, updated, folder.path);
  return updated;
}

/**
 * Deletes an empty folder. One with subfolders or assets in it is refused (409): move or delete
 * what is inside first, so nothing is deleted by accident and no asset is left filed nowhere.
 */
export async function deleteAssetFolder(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  await folderOrThrow(ctx, scope, id);
  const notEmpty = () =>
    new ConflictError('The folder is not empty: move or delete its subfolders and assets first');
  const [children, assets] = await Promise.all([
    ctx.store.assetFolders.list(scope),
    ctx.store.assets.list(scope, { limit: 1, filters: { folderId: id, status: 'all' } }),
  ]);
  if (children.some((f) => f.parentId === id) || assets.items.length > 0) throw notEmpty();
  try {
    await ctx.store.withTransaction((tx) => tx.assetFolders.delete(scope, id));
  } catch (err) {
    // Something was filed in it after the check.
    if (err instanceof TransactionConflictError) throw notEmpty();
    throw err;
  }
}
