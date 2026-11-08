import type { AssetVideoStatus } from '@commerceworker/domain';
import type { HostedVideo, VideoHost } from '@commerceworker/ports';

/**
 * Cloudflare Stream `VideoHost` over the Workers Stream binding (`env.STREAM`):
 * no API token in the Worker, and direct creator uploads go client → Stream.
 * The binding is typed structurally so the package imports no Cloudflare types.
 */

/** The subset of a Stream video's details this adapter reads. */
export interface StreamVideoLike {
  readonly id?: string;
  readonly readyToStream: boolean;
  readonly status: {
    readonly state: string;
    readonly errorReasonCode?: string;
    readonly errorReasonText?: string;
  };
  readonly thumbnail?: string;
  readonly hlsPlaybackUrl?: string;
  readonly dashPlaybackUrl?: string;
  /** `-1` while unknown. */
  readonly duration?: number;
  readonly input?: { readonly width: number; readonly height: number };
}

/** The subset of the Stream binding this adapter uses. */
export interface StreamBindingLike {
  createDirectUpload(params: {
    maxDurationSeconds: number;
    meta?: Record<string, string>;
    expiry?: string;
  }): Promise<{ uploadURL: string; id: string }>;
  video(id: string): {
    details(): Promise<StreamVideoLike>;
    delete(): Promise<void>;
  };
}

/** Normalizes Stream's processing `state` onto the asset lifecycle. */
export function mapStreamState(state: string, readyToStream: boolean): AssetVideoStatus {
  if (state === 'error') return 'error';
  if (readyToStream || state === 'ready') return readyToStream ? 'ready' : 'processing';
  if (state === 'pendingupload') return 'pending';
  // downloading | queued | inprogress | anything newer
  return 'processing';
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; message?: string; status?: number };
  return e?.name === 'NotFoundError' || e?.status === 404 || /not.?found/i.test(e?.message ?? '');
}

export function toHostedVideo(videoId: string, v: StreamVideoLike): HostedVideo {
  const status = mapStreamState(v.status.state, v.readyToStream);
  const reason = v.status.errorReasonText || v.status.errorReasonCode;
  return {
    videoId,
    status,
    ...(v.hlsPlaybackUrl ? { hlsUrl: v.hlsPlaybackUrl } : {}),
    ...(v.dashPlaybackUrl ? { dashUrl: v.dashPlaybackUrl } : {}),
    ...(v.thumbnail ? { thumbnailUrl: v.thumbnail } : {}),
    ...(v.duration !== undefined && v.duration >= 0 ? { durationSeconds: v.duration } : {}),
    ...(v.input && v.input.width > 0 ? { width: v.input.width } : {}),
    ...(v.input && v.input.height > 0 ? { height: v.input.height } : {}),
    ...(status === 'error' && reason ? { errorReason: reason } : {}),
  };
}

export interface StreamVideoHostOptions {
  /** How long a direct upload URL stays valid, seconds (default 1800). */
  readonly uploadTtlSeconds?: number;
  /** Injected for tests. */
  readonly now?: () => Date;
}

export function createStreamVideoHost(
  stream: StreamBindingLike,
  opts: StreamVideoHostOptions = {},
): VideoHost {
  const ttl = opts.uploadTtlSeconds ?? 1800;
  const now = opts.now ?? (() => new Date());
  return {
    provider: 'stream',
    async createUpload({ maxDurationSeconds, meta }) {
      const expiry = new Date(now().getTime() + ttl * 1000).toISOString();
      const created = await stream.createDirectUpload({
        maxDurationSeconds,
        expiry,
        ...(meta ? { meta: { ...meta } } : {}),
      });
      // Basic POST direct upload (≤200 MB): multipart form, field "file".
      return {
        videoId: created.id,
        uploadUrl: created.uploadURL,
        method: 'POST',
        fileField: 'file',
      };
    },
    async getVideo(videoId) {
      try {
        return toHostedVideo(videoId, await stream.video(videoId).details());
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async delete(videoId) {
      try {
        await stream.video(videoId).delete();
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
  };
}

/** What a verified Stream webhook identifies — never what it claims about status. */
export interface StreamWebhookNotice {
  readonly videoId: string;
  /** `meta` set at upload time (asset id, scope). */
  readonly meta: Readonly<Record<string, string>>;
}

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Verifies a Stream webhook (`Webhook-Signature: time=<unix>,sig1=<hex>`,
 * HMAC-SHA256 of `<time>.<raw body>`) and returns the video it is about, or
 * `null` when the signature, timestamp window, or payload is wrong.
 */
export async function verifyStreamWebhook(
  secret: string,
  signatureHeader: string | null,
  rawBody: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): Promise<StreamWebhookNotice | null> {
  if (!secret || !signatureHeader) return null;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const time = Number(parts.time);
  const sig = parts.sig1 ? hexToBytes(parts.sig1) : null;
  if (!Number.isFinite(time) || !sig) return null;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - time) > (opts.toleranceSeconds ?? 300)) return null;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sig,
    encoder.encode(`${parts.time}.${rawBody}`),
  );
  if (!ok) return null;
  let payload: { uid?: unknown; meta?: unknown };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    return null;
  }
  if (typeof payload.uid !== 'string') return null;
  const meta: Record<string, string> = {};
  if (payload.meta && typeof payload.meta === 'object') {
    for (const [k, v] of Object.entries(payload.meta as Record<string, unknown>)) {
      if (typeof v === 'string') meta[k] = v;
    }
  }
  return { videoId: payload.uid, meta };
}
