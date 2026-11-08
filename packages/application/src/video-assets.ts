import {
  type Asset,
  type AssetVideo,
  emptyAssetMetadata,
  InvalidStateError,
  type LocalizedValue,
  NotConfiguredError,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type { HostedVideo, VideoHost, VideoUpload } from '@commerceworker/ports';
import type { AppContext } from './context';
import { runHook } from './hooks';

/** Default ceiling on an upload's duration — the host reserves storage for it. */
export const DEFAULT_VIDEO_MAX_DURATION_SECONDS = 3600;
/** Hard ceiling: the host reserves `maxDurationSeconds` of storage per pending upload. */
export const MAX_VIDEO_MAX_DURATION_SECONDS = 6 * 3600;

export interface CreateVideoAssetInput {
  readonly fileName: string;
  /** Must be a `video/*` type. */
  readonly contentType: string;
  readonly title?: LocalizedValue;
  readonly description?: LocalizedValue;
  readonly maxDurationSeconds?: number;
}

export interface CreatedVideoAsset {
  readonly asset: Asset;
  /** One-time direct upload: POST the file as multipart field `upload.fileField`. */
  readonly upload: VideoUpload;
}

function requireVideoHost(ctx: AppContext): VideoHost {
  if (!ctx.video) {
    throw new NotConfiguredError(
      'video',
      'Video hosting is not configured for this deployment (bind STREAM on the edge worker)',
    );
  }
  return ctx.video;
}

/**
 * Creates a draft video asset and returns a one-time direct upload URL on the
 * video host. The client sends the bytes straight to the host; the asset
 * tracks the host's processing status until the video is playable.
 */
export async function createVideoAsset(
  ctx: AppContext,
  scope: Scope,
  input: CreateVideoAssetInput,
): Promise<CreatedVideoAsset> {
  const host = requireVideoHost(ctx);
  if (!input.contentType.startsWith('video/')) {
    throw new ValidationError([{ field: 'contentType', message: 'contentType must be video/*' }]);
  }
  const maxDurationSeconds = input.maxDurationSeconds ?? DEFAULT_VIDEO_MAX_DURATION_SECONDS;
  if (
    !Number.isInteger(maxDurationSeconds) ||
    maxDurationSeconds < 1 ||
    maxDurationSeconds > MAX_VIDEO_MAX_DURATION_SECONDS
  ) {
    throw new ValidationError([
      {
        field: 'maxDurationSeconds',
        message: `maxDurationSeconds must be an integer in 1..${MAX_VIDEO_MAX_DURATION_SECONDS}`,
      },
    ]);
  }
  // Same hook as blob assets, before the upload target exists: a refused asset
  // must not leave a usable upload URL in the caller's hands.
  const checked = await runHook(ctx, 'asset:beforeCreate', scope, {
    fileName: input.fileName,
    contentType: input.contentType,
    title: input.title,
    description: input.description,
  });

  const id = ctx.ids.newId();
  // Echoed back on status webhooks so the receiver can find the asset without
  // trusting anything else in the payload.
  const upload = await host.createUpload({
    maxDurationSeconds,
    meta: {
      assetId: id,
      spaceId: scope.spaceId,
      environmentId: scope.environmentId,
      name: checked.fileName,
    },
  });
  const video: AssetVideo = { provider: host.provider, videoId: upload.videoId, status: 'pending' };
  const asset: Asset = {
    id,
    status: 'draft',
    // No playable URL until the host finishes encoding; refresh fills it in.
    file: { url: '', fileName: checked.fileName, contentType: checked.contentType, video },
    title: checked.title ?? {},
    description: checked.description ?? {},
    metadata: emptyAssetMetadata,
  };
  await ctx.store.assets.create(scope, asset);
  return { asset, upload };
}

function toAssetVideo(provider: string, v: HostedVideo): AssetVideo {
  return {
    provider,
    videoId: v.videoId,
    status: v.status,
    ...(v.hlsUrl ? { hlsUrl: v.hlsUrl } : {}),
    ...(v.dashUrl ? { dashUrl: v.dashUrl } : {}),
    ...(v.thumbnailUrl ? { thumbnailUrl: v.thumbnailUrl } : {}),
    ...(v.durationSeconds !== undefined ? { durationSeconds: v.durationSeconds } : {}),
    ...(v.errorReason ? { errorReason: v.errorReason } : {}),
  };
}

/**
 * Re-reads a video asset's processing status from the host and stores it:
 * playback (HLS/DASH), poster, duration, dimensions. The host is the source of
 * truth — webhooks only say *when* to call this, never *what* to store, so a
 * forged or replayed notification can at worst cause a redundant read.
 *
 * A published asset's snapshot gets the same video in the same unit, with an
 * `asset.published` event so caches purge: a video published before Stream
 * finished encoding becomes playable in Delivery without being republished.
 */
export async function refreshVideoAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  const host = requireVideoHost(ctx);
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  const current = asset.file.video;
  if (!current) throw new InvalidStateError('Asset is not a hosted video');
  if (current.provider !== host.provider) {
    throw new InvalidStateError(
      `Asset video is hosted by "${current.provider}", not the bound "${host.provider}"`,
    );
  }
  const hosted = await host.getVideo(current.videoId);
  const video: AssetVideo = hosted
    ? toAssetVideo(host.provider, hosted)
    : { ...current, status: 'error', errorReason: 'Video no longer exists on the host' };
  const refreshed = (a: Asset): Asset => ({
    ...a,
    file: {
      ...a.file,
      // The HLS manifest is the closest thing a stream has to "the file URL".
      url: video.hlsUrl ?? a.file.url,
      ...(hosted?.width && hosted.width > 0 ? { width: hosted.width } : {}),
      ...(hosted?.height && hosted.height > 0 ? { height: hosted.height } : {}),
      video,
    },
  });
  return ctx.store.withTransaction(async (tx) => {
    // Re-read inside the unit: the host call took time, and an edit or publish in between must
    // not be overwritten with the copy read before it, nor a delete undone by saving it again.
    const current = await tx.assets.get(scope, id);
    if (!current) throw new NotFoundError('Asset', id);
    const published =
      current.status === 'published' ? await tx.assets.getPublished(scope, id) : null;
    const updated = refreshed(current);
    await tx.assets.save(scope, updated);
    if (published && published.file.video?.videoId === current.file.video?.videoId) {
      // The snapshot keeps what was published (title, metadata, when); only the video moves on.
      const file = refreshed({ ...current, file: published.file }).file;
      await tx.assets.putPublished(scope, { ...published, file });
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'asset.published',
        scope,
        occurredAt: ctx.clock.now().toISOString(),
        assetId: id,
      });
    }
    return updated;
  });
}
