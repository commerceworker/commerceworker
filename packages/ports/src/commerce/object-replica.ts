/**
 * The R2 bucket of order documents (`DOCS`) and its replica. `ObjectBucket` is the part of a bucket
 * the replication reads and writes, `ObjectReader` the part a read needs. The consumer, the nightly
 * reconcile (packages/application, `object-replica.ts`) and the read fallback take these;
 * `createR2ObjectBucket` and `createReplicaFallbackBucket` (packages/adapters) and
 * `InMemoryObjectBucket` (packages/test-kit) implement them.
 */

/** What a bucket holds about an object besides its bytes. */
export interface ObjectInfo {
  readonly key: string;
  readonly size: number;
  /** The bucket's own etag (an MD5 for a single-part upload). */
  readonly etag: string;
  readonly contentType?: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface ObjectContent extends ObjectInfo {
  readonly body: ReadableStream;
}

export interface ObjectWrite {
  readonly contentType?: string;
  readonly customMetadata?: Record<string, string>;
}

export interface ObjectBucket {
  head(key: string): Promise<ObjectInfo | null>;
  read(key: string): Promise<ObjectContent | null>;
  /** Writes over the key: a retry stores the same object again. */
  write(key: string, body: ReadableStream | ArrayBuffer | string, meta: ObjectWrite): Promise<void>;
  remove(key: string): Promise<void>;
  /** Keys in order, with their metadata; `cursor` is set while more remain. */
  list(options: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: ObjectInfo[]; cursor?: string }>;
}

/** An object read for its body: an R2 `get` result is one. */
export interface ObjectBody {
  readonly body: ReadableStream;
  readonly size: number;
  readonly httpMetadata?: { readonly contentType?: string };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ObjectReader {
  get(key: string): Promise<ObjectBody | null>;
}
