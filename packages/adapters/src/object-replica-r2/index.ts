import type {
  ObjectBody,
  ObjectBucket,
  ObjectInfo,
  ObjectReader,
} from '@commerceworker/ports/commerce';

/** An R2 object's metadata, as `head` and `list` return it. */
export interface R2InfoLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly httpMetadata?: { readonly contentType?: string };
  readonly customMetadata?: Record<string, string>;
}

/** An R2 object with its body (`get`). */
export interface R2ContentLike extends R2InfoLike, ObjectBody {}

/** The subset of an R2 bucket binding the replication uses; a binding fits as is. */
export interface R2ReplicaBucketLike {
  head(key: string): Promise<R2InfoLike | null>;
  get(key: string): Promise<R2ContentLike | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    include?: ('httpMetadata' | 'customMetadata')[];
  }): Promise<{ objects: R2InfoLike[]; truncated: boolean; cursor?: string }>;
}

const info = (o: R2InfoLike): ObjectInfo => ({
  key: o.key,
  size: o.size,
  etag: o.etag,
  ...(o.httpMetadata?.contentType ? { contentType: o.httpMetadata.contentType } : {}),
  ...(o.customMetadata && Object.keys(o.customMetadata).length
    ? { customMetadata: o.customMetadata }
    : {}),
});

/** A bucket as the replication port: object metadata, bodies as streams, keys listed in order. */
export function createR2ObjectBucket(bucket: R2ReplicaBucketLike): ObjectBucket {
  return {
    async head(key) {
      const o = await bucket.head(key);
      return o && info(o);
    },
    async read(key) {
      const o = await bucket.get(key);
      return o && { ...info(o), body: o.body };
    },
    async write(key, body, meta) {
      await bucket.put(key, body, {
        ...(meta.contentType ? { httpMetadata: { contentType: meta.contentType } } : {}),
        ...(meta.customMetadata ? { customMetadata: meta.customMetadata } : {}),
      });
    },
    async remove(key) {
      await bucket.delete(key);
    },
    async list({ prefix, cursor, limit }) {
      const page = await bucket.list({
        ...(prefix ? { prefix } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit } : {}),
        include: ['httpMetadata', 'customMetadata'],
      });
      return {
        objects: page.objects.map(info),
        ...(page.truncated ? { cursor: page.cursor } : {}),
      };
    },
  };
}

/** A read that didn't answer in time. */
export class ReplicaReadTimeout extends Error {
  override name = 'ReplicaReadTimeout';
}

/** Why a read went to the replica. */
export type FallbackReason = 'timeout' | 'error';

/** The part of the primary bucket the fallback wraps. */
export interface FallbackBucketLike extends ObjectReader {
  head(key: string): Promise<unknown>;
  put(key: string, value: never, options?: never): Promise<unknown>;
  delete(keys: string | string[]): Promise<unknown>;
}

export interface ReplicaFallbackOptions {
  /** How long the primary has to answer a read; default 3,000 ms. */
  timeoutMs?: number;
  /** Called once for each read the replica answered, so it can be counted. */
  onFallback(event: { key: string; reason: FallbackReason; found: boolean }): void;
}

/**
 * An error the service sent (a 5xx, or R2's own internal error): worth reading the replica for.
 * A `get` of a missing key returns null rather than throwing, so what throws is the service, bar a
 * bug in our call (a TypeError or RangeError) and an error that carries a 4xx status.
 */
function isServiceFailure(err: unknown) {
  if (err instanceof TypeError || err instanceof RangeError) return false;
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status >= 500;
}

/**
 * The primary bucket with one change: a read that times out or fails with a service error reads
 * the replica's copy instead. A key the primary answers for (including "no such key") is never
 * looked up in the replica, and a write or delete goes to the primary alone: a replica that took
 * a write would hold what the primary doesn't, and failing over a write has no safe answer.
 */
export function createReplicaFallbackBucket<P extends FallbackBucketLike>(
  primary: P,
  replica: ObjectReader,
  options: ReplicaFallbackOptions,
) {
  const timeoutMs = options.timeoutMs ?? 3000;
  return {
    head: primary.head.bind(primary),
    put: primary.put.bind(primary),
    delete: primary.delete.bind(primary),
    async get(key: string): Promise<ObjectBody | null> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const asked = primary.get(key);
      try {
        return await Promise.race([
          asked,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new ReplicaReadTimeout(`${key}: no answer in ${timeoutMs} ms`)),
              timeoutMs,
            );
          }),
        ]);
      } catch (err) {
        const timedOut = err instanceof ReplicaReadTimeout;
        if (!timedOut && !isServiceFailure(err)) throw err;
        // A late answer is dropped, its body with it.
        if (timedOut)
          asked.then(
            (o) => o?.body.cancel(),
            () => undefined,
          );
        let copy: ObjectBody | null;
        try {
          copy = await replica.get(key);
        } catch {
          throw err;
        }
        options.onFallback({ key, reason: timedOut ? 'timeout' : 'error', found: !!copy });
        return copy;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
