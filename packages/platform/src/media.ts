/**
 * The media routes' Cloudflare adapters, bound at the composition root: signed R2 transfers (with
 * Images transforms when the binding is there) and Stream's webhook signature. `packages/http`'s
 * `mediaRoutes` takes what this returns and binds no adapter itself.
 */
import {
  handleMediaRequest,
  keyFromMediaPath,
  type MediaUrlSigner,
  type R2BucketLike,
  safeHeaders,
} from '@commerceworker/adapters/blob-r2';
import {
  type ImagesBindingLike,
  transformImage,
  transformParams,
} from '@commerceworker/adapters/images-cf';
import { verifyStreamWebhook } from '@commerceworker/adapters/video-stream';
import type { FocalPoint } from '@commerceworker/domain';
import type { ImageTransformSpec } from '@commerceworker/ports';

export interface MediaAdapters {
  /** A signed `/media/*` transfer: PUT stores the upload, GET or HEAD streams it back. */
  readonly transfer?: (request: Request) => Promise<Response>;
  /** The object key a `/media/*` path names, or null. */
  readonly keyFromPath: (pathname: string) => string | null;
  /** A Stream notice whose signature verifies, or null. */
  readonly verifyStreamNotice?: (
    signature: string | null,
    raw: string,
  ) => Promise<{ videoId: string; meta: Readonly<Record<string, string>> } | null>;
}

export function mediaAdapters(o: {
  bucket?: R2BucketLike;
  signer?: MediaUrlSigner;
  images?: ImagesBindingLike;
  streamWebhookSecret?: string;
  readOnly?: boolean;
  requireExpiry?: boolean;
  /** Injected for tests; seconds since the epoch. */
  now?: () => number;
}): MediaAdapters {
  const { bucket, signer, images, streamWebhookSecret: secret, now } = o;
  return {
    keyFromPath: keyFromMediaPath,
    ...(bucket && signer
      ? {
          transfer: (request: Request) =>
            handleMediaRequest(request, {
              bucket,
              signer,
              ...(o.readOnly !== undefined ? { readOnly: o.readOnly } : {}),
              ...(o.requireExpiry !== undefined ? { requireExpiry: o.requireExpiry } : {}),
              ...(now ? { now } : {}),
              ...(images
                ? {
                    transform: (object, params, req) =>
                      transformImage(
                        images,
                        object.body,
                        object.httpMetadata?.contentType ?? '',
                        params,
                        req.headers.get('accept'),
                      ),
                  }
                : {}),
            }),
        }
      : {}),
    ...(secret
      ? {
          verifyStreamNotice: (signature: string | null, raw: string) =>
            verifyStreamWebhook(secret, signature, raw, now ? { nowSeconds: now() } : {}),
        }
      : {}),
  };
}

/** Read and transform adapters used by the published-media miss path. */
export interface PublishedMediaAdapters {
  readonly bucket: Pick<R2BucketLike, 'get' | 'head'>;
  readonly headers: (contentType: string) => Headers;
  readonly transform?: (
    body: ReadableStream<Uint8Array>,
    contentType: string,
    spec: ImageTransformSpec,
    focal: FocalPoint | undefined,
    accept: string | null,
  ) => Promise<Response | null>;
}

export function publishedMediaAdapters(o: {
  bucket: R2BucketLike;
  images?: ImagesBindingLike;
}): PublishedMediaAdapters {
  const { bucket, images } = o;
  return {
    bucket,
    headers: safeHeaders,
    ...(images
      ? {
          transform: (
            body: ReadableStream<Uint8Array>,
            contentType: string,
            spec: ImageTransformSpec,
            focal: FocalPoint | undefined,
            accept: string | null,
          ) => transformImage(images, body, contentType, transformParams(spec, focal), accept),
        }
      : {}),
  };
}
