import {
  type Asset,
  clearAcceptedSuggestions,
  DomainError,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import {
  type AssetBulkJobAction,
  type BulkItemFailure,
  type BulkJob,
  type BulkJobChunk,
  TransactionConflictError,
} from '@commerceworker/ports';
import { archiveAsset, publishAsset, unpublishAsset } from './assets';
import type { BulkChunkOutcome } from './bulk-jobs';
import { startBulkJob } from './bulk-jobs';
import type { AppContext } from './context';

/**
 * The asset library's bulk actions as resumable bulk jobs: the same chunked, CAS-claimed, swept
 * machinery as entry bulk publishing (`bulk-jobs.ts`), over asset ids. Each asset goes through the
 * use-case a single action uses (publishing checks rights and archive state the same way), so a
 * job can do nothing one asset at a time couldn't. Progress and the per-asset report are the job's
 * (`…/bulk/jobs/:id`); a failure names the asset by its title or file name.
 */

/** What a bulk action does to each selected asset. */
export type AssetBulkAction = 'move' | 'tag' | 'publish' | 'unpublish' | 'archive';

export const ASSET_BULK_ACTION_NAMES: readonly AssetBulkAction[] = [
  'move',
  'tag',
  'publish',
  'unpublish',
  'archive',
];

export interface StartAssetBulkJobInput {
  readonly action: AssetBulkAction;
  readonly ids: readonly string[];
  /** `move`: the folder (`null`: the library's root). */
  readonly folderId?: string | null;
  /** `tag`: tag ids to add to every asset, and to take off. */
  readonly addTags?: readonly string[];
  readonly removeTags?: readonly string[];
}

/** Most tag ids one tagging job adds and removes together. */
export const MAX_ASSET_BULK_TAGS = 50;

/** The longest tag id a tagging job takes, as an id anywhere else in the API. */
const MAX_TAG_ID_LENGTH = 128;

/**
 * Whether `action` changes what Delivery serves, and so needs `content:publish` as the
 * single-asset routes do; the others (move, tag) need `content:write`. One rule for both surfaces.
 */
export const assetBulkActionPublishes = (action: AssetBulkAction): boolean =>
  action === 'publish' || action === 'unpublish' || action === 'archive';

/** What a job remembers of its request (the job's `config`), read back by its chunks. */
interface AssetBulkConfig {
  readonly folderId?: string | null;
  readonly addTags?: readonly string[];
  readonly removeTags?: readonly string[];
}

const jobAction = (action: AssetBulkAction): AssetBulkJobAction => `asset_${action}`;

/**
 * Starts a bulk job over a selection of assets. Validated up front (a folder that exists, tags to
 * apply), so a job that could only fail never starts; per-asset problems (an archived asset to
 * publish, one deleted meanwhile, an embargo) are reported per asset when its chunk runs.
 */
export async function startAssetBulkJob(
  ctx: AppContext,
  scope: Scope,
  input: StartAssetBulkJobInput,
): Promise<BulkJob> {
  let config: AssetBulkConfig | undefined;
  switch (input.action) {
    case 'move': {
      if (input.folderId === undefined) {
        throw new ValidationError([
          { field: 'folderId', message: 'Name the folder to move to (null: the root)' },
        ]);
      }
      if (input.folderId !== null && !(await ctx.store.assetFolders.get(scope, input.folderId))) {
        throw new NotFoundError('AssetFolder', input.folderId);
      }
      config = { folderId: input.folderId };
      break;
    }
    case 'tag': {
      const addTags = [...new Set(input.addTags ?? [])];
      const removeTags = [...new Set(input.removeTags ?? [])];
      if (addTags.length + removeTags.length === 0) {
        throw new ValidationError([
          { field: 'addTags', message: 'Name at least one tag to add or remove' },
        ]);
      }
      if (addTags.length + removeTags.length > MAX_ASSET_BULK_TAGS) {
        throw new ValidationError([
          { field: 'addTags', message: `At most ${MAX_ASSET_BULK_TAGS} tags at a time` },
        ]);
      }
      // The use-case checks what it writes into every asset, whichever surface sent it.
      const bad = [...addTags, ...removeTags].find(
        (t) => t.trim() === '' || t.length > MAX_TAG_ID_LENGTH,
      );
      if (bad !== undefined) {
        throw new ValidationError([
          { field: 'addTags', message: `A tag id is 1 to ${MAX_TAG_ID_LENGTH} characters` },
        ]);
      }
      if (addTags.some((t) => removeTags.includes(t))) {
        throw new ValidationError([
          { field: 'removeTags', message: 'A tag cannot be both added and removed' },
        ]);
      }
      config = { addTags, removeTags };
      break;
    }
    default:
      break;
  }
  return startBulkJob(ctx, scope, {
    action: jobAction(input.action),
    entryIds: input.ids,
    ...(config ? { config: { ...config } } : {}),
  });
}

/** How a person knows an asset: its first title, else its file name. */
export function assetDisplayName(asset: Asset): string {
  const title = Object.values(asset.title).find((t) => typeof t === 'string' && t.trim() !== '');
  return typeof title === 'string' ? title.trim() : asset.file.fileName;
}

/**
 * The chunk runner for asset bulk jobs: applies the job's action to the chunk's assets and reports
 * each one that failed, by name. Safe to run twice (a redelivery, the stall sweep): moving, tagging,
 * archiving and unpublishing again change nothing, and publishing again republishes what is there.
 */
export function assetBulkChunkRunner(
  ctx: AppContext,
): (scope: Scope, job: BulkJob, chunk: BulkJobChunk) => Promise<BulkChunkOutcome> {
  return async (scope, job, chunk) => {
    const found = new Map(
      (await ctx.store.assets.getMany(scope, chunk.entryIds)).map((a) => [a.id, a]),
    );
    const failures: BulkItemFailure[] = [];
    const present: Asset[] = [];
    for (const id of chunk.entryIds) {
      const asset = found.get(id);
      if (asset) present.push(asset);
      else failures.push({ id, error: 'Asset not found' });
    }
    const config = (job.config ?? {}) as AssetBulkConfig;
    switch (job.action) {
      case 'asset_move':
        failures.push(...(await moveChunk(ctx, scope, present, config.folderId ?? null)));
        break;
      case 'asset_tag':
        await tagChunk(ctx, scope, present, config.addTags ?? [], config.removeTags ?? []);
        break;
      case 'asset_publish':
        failures.push(...(await eachAsset(present, (a) => publishAsset(ctx, scope, a.id))));
        break;
      case 'asset_unpublish':
        failures.push(
          ...(await eachAsset(present, async (a) => {
            // Already out of Delivery: nothing to do, and no failure (a re-run lands here).
            if (a.status === 'published') await unpublishAsset(ctx, scope, a.id);
          })),
        );
        break;
      case 'asset_archive':
        failures.push(...(await eachAsset(present, (a) => archiveAsset(ctx, scope, a.id))));
        break;
      default:
        throw new Error(`Not an asset bulk action: ${job.action}`);
    }
    return { succeeded: chunk.entryIds.length - failures.length, failures };
  };
}

/** One statement for the chunk; a folder deleted since the job started fails every asset in it. */
async function moveChunk(
  ctx: AppContext,
  scope: Scope,
  assets: readonly Asset[],
  folderId: string | null,
): Promise<BulkItemFailure[]> {
  if (assets.length === 0) return [];
  try {
    await ctx.store.withTransaction((tx) =>
      tx.assets.moveToFolder(
        scope,
        assets.map((a) => a.id),
        folderId,
      ),
    );
    return [];
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    return assets.map((a) => ({
      id: a.id,
      name: assetDisplayName(a),
      error: 'The folder was deleted',
    }));
  }
}

/**
 * Adds and removes tags across the chunk in one unit. A tag a person adds this way is theirs (an AI
 * suggestion marker on a tag it removes goes with the tag); assets whose tags don't change aren't
 * written.
 */
async function tagChunk(
  ctx: AppContext,
  scope: Scope,
  assets: readonly Asset[],
  add: readonly string[],
  remove: readonly string[],
): Promise<void> {
  const changed = assets.flatMap((asset) => {
    const kept = asset.metadata.tags.filter((t) => !remove.includes(t));
    const tags = [...kept, ...add.filter((t) => !kept.includes(t))];
    if (
      tags.length === asset.metadata.tags.length &&
      tags.every((t, i) => asset.metadata.tags[i] === t)
    ) {
      return [];
    }
    const aiSuggestions = clearAcceptedSuggestions(asset.aiSuggestions, asset.metadata, { tags });
    const { aiSuggestions: _was, ...rest } = asset;
    const updated: Asset = {
      ...rest,
      metadata: { ...asset.metadata, tags },
      ...(aiSuggestions ? { aiSuggestions } : {}),
    };
    return [updated];
  });
  if (changed.length === 0) return;
  await ctx.store.withTransaction(async (tx) => {
    for (const asset of changed) await tx.assets.save(scope, asset);
  });
}

/** Runs `act` on each asset in turn; a refusal (a domain error) is that asset's failure. */
async function eachAsset(
  assets: readonly Asset[],
  act: (asset: Asset) => Promise<unknown>,
): Promise<BulkItemFailure[]> {
  const failures: BulkItemFailure[] = [];
  for (const asset of assets) {
    try {
      await act(asset);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      failures.push({ id: asset.id, name: assetDisplayName(asset), error: err.message });
    }
  }
  return failures;
}
