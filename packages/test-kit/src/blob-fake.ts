import type {
  BlobHead,
  BlobObject,
  BlobStore,
  DownloadUrlOptions,
  MultipartBlobStore,
  UploadedPart,
} from '@commerceworker/ports';

/**
 * An in-memory BlobStore for dev/tests. It hands out deterministic fake
 * presigned URLs and records uploads/deletes — no bytes are stored. Mirrors the
 * R2 adapter's contract (presigned PUT for upload, URL for download).
 */
export class FakeBlobStore implements BlobStore {
  readonly uploads: { key: string; contentType: string }[] = [];
  readonly deletes: string[] = [];
  constructor(private readonly base = 'https://blob.local') {}

  async getUploadUrl(key: string, contentType: string) {
    this.uploads.push({ key, contentType });
    return { url: `${this.base}/${key}?upload=1`, headers: { 'content-type': contentType } };
  }
  /** A short-lived URL says so (`?ttl=`), so a test can tell it from the stored one. */
  async getDownloadUrl(key: string, opts?: DownloadUrlOptions) {
    const url = `${opts?.origin ?? this.base}/${key}`;
    return opts?.expiresInSeconds ? `${url}?ttl=${opts.expiresInSeconds}` : url;
  }
  async delete(key: string) {
    this.deletes.push(key);
    this.objects.delete(key);
  }

  /** Actually holds bytes, so checksum verification is exercised for real. */
  private readonly objects = new Map<string, string | Uint8Array>();

  async put(key: string, body: string | Uint8Array, contentType: string) {
    this.objects.set(key, body);
    this.types.set(key, contentType);
    this.etags.set(key, `etag-${++this.writes}`);
  }

  /** An etag per write, as R2 gives one: the same key written again names other bytes. */
  private readonly etags = new Map<string, string>();
  private writes = 0;

  async head(key: string): Promise<BlobHead | null> {
    const bytes = this.bytes(key);
    if (!bytes) return null;
    const contentType = this.types.get(key);
    const etag = this.etags.get(key);
    return {
      size: bytes.byteLength,
      ...(contentType ? { contentType } : {}),
      ...(etag ? { etag } : {}),
    };
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (body === undefined) return null;
    // A fake: bytes read back one char per byte (exact for the ASCII the tests write).
    return typeof body === 'string' ? body : String.fromCharCode(...body);
  }

  async deletePrefix(prefix: string, keep: (key: string) => boolean): Promise<number> {
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix) && !keep(key)) {
        this.objects.delete(key);
        this.deletes.push(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  /** Every key `open` was asked for, in order: a test proves what ingest read. */
  readonly opened: string[] = [];

  async open(key: string): Promise<BlobObject | null> {
    this.opened.push(key);
    const bytes = this.bytes(key);
    if (!bytes) return null;
    const contentType = this.types.get(key);
    return {
      body: (async function* () {
        yield bytes;
      })(),
      size: bytes.byteLength,
      ...(contentType ? { contentType } : {}),
    };
  }

  private readonly types = new Map<string, string>();

  /** Every range `openRange` read: `key@offset+length`. */
  readonly rangesRead: string[] = [];

  async openRange(key: string, offset: number, length: number): Promise<BlobObject | null> {
    this.rangesRead.push(`${key}@${offset}+${length}`);
    const bytes = this.bytes(key);
    if (!bytes) return null;
    const slice = bytes.subarray(offset, offset + length);
    const contentType = this.types.get(key);
    return {
      // In two chunks when it can be, so a reader that assumes one chunk is caught.
      body: (async function* () {
        const half = Math.floor(slice.byteLength / 2);
        if (half > 0) yield slice.subarray(0, half);
        yield slice.subarray(half);
      })(),
      size: bytes.byteLength,
      ...(contentType ? { contentType } : {}),
    };
  }

  /** Multipart uploads in progress, by upload id, with R2's rules: equal parts but the last. */
  readonly uploadsInProgress = new Map<
    string,
    { key: string; contentType: string; parts: Map<number, Uint8Array> }
  >();
  /** Upload ids aborted, in order. */
  readonly aborted: string[] = [];
  private uploadSeq = 0;

  readonly multipart: MultipartBlobStore = {
    create: async (key, contentType) => {
      const uploadId = `upload-${++this.uploadSeq}`;
      this.uploadsInProgress.set(uploadId, { key, contentType, parts: new Map() });
      return { uploadId };
    },
    partUrl: async (key, uploadId, partNumber, length) => ({
      url: `${this.base}/${key}?uploadId=${uploadId}&part=${partNumber}&len=${length}`,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }),
    uploadPart: async (key, uploadId, partNumber, body): Promise<UploadedPart> => {
      const upload = this.uploadsInProgress.get(uploadId);
      if (!upload || upload.key !== key) throw new Error(`no multipart upload ${uploadId}`);
      upload.parts.set(partNumber, body.slice());
      return { partNumber, etag: `part-${uploadId}-${partNumber}-${body.byteLength}` };
    },
    complete: async (key, uploadId, parts) => {
      const upload = this.uploadsInProgress.get(uploadId);
      if (!upload || upload.key !== key) throw new Error(`no multipart upload ${uploadId}`);
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const chunks = ordered.map((p) => {
        const bytes = upload.parts.get(p.partNumber);
        if (!bytes) throw new Error(`part ${p.partNumber} was never uploaded`);
        return bytes;
      });
      const first = chunks[0]?.byteLength ?? 0;
      if (chunks.slice(0, -1).some((c) => c.byteLength !== first)) {
        throw new Error('All non-trailing parts must have the same size');
      }
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      this.uploadsInProgress.delete(uploadId);
      await this.put(key, out, upload.contentType);
      return {
        size: total,
        contentType: upload.contentType,
        etag: `${this.etags.get(key)}-${chunks.length}`,
      };
    },
    abort: async (_key, uploadId) => {
      this.aborted.push(uploadId);
      this.uploadsInProgress.delete(uploadId);
    },
  };

  /** The stored bytes of `key`, as written (a test reads back a binary upload with this). */
  bytes(key: string): Uint8Array | null {
    const body = this.objects.get(key);
    if (body === undefined) return null;
    return typeof body === 'string' ? Uint8Array.from(body, (c) => c.charCodeAt(0)) : body;
  }

  /**
   * Every key currently stored.
   *
   * Exists so a test can assert that a rejected operation wrote *nothing* —
   * "it also failed to store the bad bytes" is not observable through the port
   * itself, and without this the assertion silently passes either way.
   */
  keys(): string[] {
    return [...this.objects.keys()];
  }
}
