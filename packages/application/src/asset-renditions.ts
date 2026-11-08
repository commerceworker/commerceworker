import {
  type AssetRendition,
  type AssetRenditionSpec,
  assetRenditionName,
  assetRenditionSpec,
  ConflictError,
  MAX_ASSET_RENDITIONS,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type { ContentStoreTx } from '@commerceworker/ports';
import type { AppContext } from './context';

/** The space's rendition presets, by name. */
export async function listAssetRenditions(
  ctx: AppContext,
  scope: Scope,
): Promise<AssetRendition[]> {
  return ctx.store.assetRenditions.list(scope);
}

export async function getAssetRendition(
  ctx: AppContext,
  scope: Scope,
  name: string,
): Promise<AssetRendition> {
  const rendition = await ctx.store.assetRenditions.get(scope, name);
  if (!rendition) throw new NotFoundError('AssetRendition', name);
  return rendition;
}

/**
 * The change and its `asset_renditions.changed` event in one unit: the engine purges what the
 * media origin cached for the rendition, and the delivery responses that list it, only for a
 * change that committed.
 */
async function writeRendition(
  ctx: AppContext,
  scope: Scope,
  name: string,
  write: (tx: ContentStoreTx) => Promise<void>,
): Promise<void> {
  await ctx.store.withTransaction(async (tx) => {
    await write(tx);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'asset_renditions.changed',
      scope,
      occurredAt: ctx.clock.now().toISOString(),
      name,
    });
  });
}

/**
 * Creates a rendition preset: every published image in the space is then also served at
 * `…/r-<name>/…`. The name is its URL segment, so it can't be taken twice; a space has at most
 * {@link MAX_ASSET_RENDITIONS}.
 */
export async function createAssetRendition(
  ctx: AppContext,
  scope: Scope,
  input: AssetRenditionSpec & { readonly name: string },
): Promise<AssetRendition> {
  const name = assetRenditionName(input.name);
  const spec = assetRenditionSpec(input);
  const existing = await ctx.store.assetRenditions.list(scope);
  if (existing.some((r) => r.name === name)) {
    throw new ConflictError(`A rendition named "${name}" already exists`);
  }
  if (existing.length >= MAX_ASSET_RENDITIONS) {
    throw new ValidationError([
      { field: 'name', message: `A space has at most ${MAX_ASSET_RENDITIONS} renditions` },
    ]);
  }
  const now = ctx.clock.now().toISOString();
  const rendition: AssetRendition = { name, ...spec, createdAt: now, updatedAt: now };
  await writeRendition(ctx, scope, name, (tx) => tx.assetRenditions.put(scope, rendition));
  return rendition;
}

/**
 * Replaces what a rendition does. Its URLs stay the same, so the engine purges the images cached
 * under them; a browser that already holds one keeps it until its own cache lets go.
 */
export async function updateAssetRendition(
  ctx: AppContext,
  scope: Scope,
  name: string,
  input: AssetRenditionSpec,
): Promise<AssetRendition> {
  const current = await getAssetRendition(ctx, scope, name);
  const spec = assetRenditionSpec(input);
  const rendition: AssetRendition = {
    name,
    ...spec,
    createdAt: current.createdAt,
    updatedAt: ctx.clock.now().toISOString(),
  };
  await writeRendition(ctx, scope, name, (tx) => tx.assetRenditions.put(scope, rendition));
  return rendition;
}

/** Deletes a rendition preset; its URLs answer 404 once the engine has purged them. */
export async function deleteAssetRendition(
  ctx: AppContext,
  scope: Scope,
  name: string,
): Promise<void> {
  await getAssetRendition(ctx, scope, name);
  await writeRendition(ctx, scope, name, (tx) => tx.assetRenditions.delete(scope, name));
}
