import {
  handleMediaRequest,
  keyFromMediaPath,
  type MediaUrlSigner,
  type R2BucketLike,
} from '@commerceworker/adapters/blob-r2';
import { type ImagesBindingLike, transformImage } from '@commerceworker/adapters/images-cf';
import { verifyStreamWebhook } from '@commerceworker/adapters/video-stream';
import { type AppContext, refreshVideoAsset } from '@commerceworker/application';
import { NotFoundError } from '@commerceworker/domain';
import { Hono } from 'hono';

export interface MediaRouteDeps {
  readonly ctx: AppContext;
  readonly bucket?: R2BucketLike;
  readonly signer?: MediaUrlSigner;
  readonly images?: ImagesBindingLike;
  readonly streamWebhookSecret?: string;
  /**
   * Called with the key and etag of each upload the signed PUT stored, to start its ingest. R2's
   * own notification starts it too where notifications exist (not in local development); the
   * run id is the bytes', so whichever arrives first starts the one run. A PUT that finds the key
   * already stored (412: an upload URL never writes over a file) starts nothing. A failure here is
   * logged, never the upload's.
   */
  readonly onUploaded?: (key: string, etag?: string) => Promise<void>;
  /** Injected for tests; seconds since the epoch. */
  readonly now?: () => number;
}

/**
 * Cloudflare-native media routes, mounted before the API:
 *
 *  - `/media/*` — signed R2 transfers. PUT streams an upload into the bucket;
 *    GET streams the object back, or through the Images binding when the
 *    signed URL carries transform params. The signature IS the authorization
 *    (it was minted by an authenticated createAsset / transform call), the
 *    same model as any presigned URL.
 *  - `POST /webhooks/stream` — Stream's processing notifications. Verified,
 *    then used only as a trigger: the asset is refreshed from the Stream API,
 *    never from the payload.
 */
export function mediaRoutes(deps: MediaRouteDeps): Hono {
  const app = new Hono();
  const { bucket, signer } = deps;

  if (bucket && signer) {
    app.on(['GET', 'HEAD', 'PUT'], '/media/*', async (c) => {
      const res = await handleMediaRequest(c.req.raw, {
        bucket,
        signer,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.images
          ? {
              transform: (object, params, request) =>
                transformImage(
                  deps.images as ImagesBindingLike,
                  object.body,
                  object.httpMetadata?.contentType ?? '',
                  params,
                  request.headers.get('accept'),
                ),
            }
          : {}),
      });
      // A multipart part (`upload=` in the signed URL) is not a file yet: completing the upload
      // starts its ingest.
      const part = new URL(c.req.url).searchParams.has('upload');
      if (c.req.method === 'PUT' && res.ok && deps.onUploaded && !part) {
        const key = keyFromMediaPath(new URL(c.req.url).pathname);
        if (key) {
          const etag = res.headers.get('etag') ?? undefined;
          await deps.onUploaded(key, etag).catch((err: unknown) => {
            console.error('upload ingest notice failed', { key, error: String(err) });
          });
        }
      }
      return res;
    });
  }

  if (deps.streamWebhookSecret) {
    const secret = deps.streamWebhookSecret;
    app.post('/webhooks/stream', async (c) => {
      const raw = await c.req.text();
      const notice = await verifyStreamWebhook(
        secret,
        c.req.header('webhook-signature') ?? null,
        raw,
        deps.now ? { nowSeconds: deps.now() } : {},
      );
      if (!notice) return c.text('invalid signature', 401);
      const { assetId, spaceId, environmentId } = notice.meta;
      // Not ours (uploaded outside commerceworker): acknowledge so Stream stops retrying.
      if (!assetId || !spaceId || !environmentId) return c.body(null, 204);
      const scope = { spaceId, environmentId };
      const asset = await deps.ctx.store.assets.get(scope, assetId);
      if (!asset || asset.file.video?.videoId !== notice.videoId) return c.body(null, 204);
      try {
        await refreshVideoAsset(deps.ctx, scope, assetId);
      } catch (err) {
        if (err instanceof NotFoundError) return c.body(null, 204);
        throw err;
      }
      return c.body(null, 204);
    });
  }

  return app;
}
