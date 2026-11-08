/**
 * Uploading a file of any size: one signed PUT up to {@link SINGLE_UPLOAD_MAX_BYTES}, a multipart
 * upload above it, with each part retried on its own and progress reported in bytes.
 */

/** What one signed PUT takes (the api's request-body cap); larger files go in parts. */
export const SINGLE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Bytes the uploader can slice: a `Blob` (a browser `File`), an `ArrayBuffer` or bytes. */
export type UploadBody = Blob | ArrayBuffer | Uint8Array;

export interface UploadProgress {
  /** Bytes the server has confirmed so far. */
  readonly loaded: number;
  readonly total: number;
  /** Parts done of the upload's parts (1 of 1 for a single PUT). */
  readonly partsDone: number;
  readonly partCount: number;
}

export interface UploadOptions {
  /** Called after the upload starts and after each part lands. */
  readonly onProgress?: (progress: UploadProgress) => void;
  /** Parts in flight at once (default 4). */
  readonly concurrency?: number;
  /** Attempts per part before the upload is given up (default 4; each with backoff). */
  readonly attempts?: number;
  /** Aborts the upload (a multipart upload is aborted on the server too). */
  readonly signal?: AbortSignal;
  /** Waits between attempts; injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export const sizeOf = (body: UploadBody): number =>
  body instanceof Blob ? body.size : body.byteLength;

/** `length` bytes of `body` from `offset`, without copying the whole file. */
export function sliceOf(body: UploadBody, offset: number, length: number): Blob | Uint8Array {
  if (body instanceof Blob) return body.slice(offset, offset + length);
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  return bytes.subarray(offset, offset + length);
}

/** Runs `tasks` with at most `limit` at once; the first failure rejects (after the rest settle). */
export async function inPool<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined && next < tasks.length) {
      const i = next++;
      try {
        out[i] = await (tasks[i] as () => Promise<T>)();
      } catch (err) {
        failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  if (failure !== undefined) throw failure;
  return out;
}

/**
 * Retries `attempt` with exponential backoff (500 ms, 1 s, 2 s…), never past `signal`, and never
 * an error `retryable` says another attempt can't fix.
 */
export async function withRetry<T>(
  attempt: () => Promise<T>,
  opts: {
    attempts: number;
    signal?: AbortSignal;
    sleep: (ms: number) => Promise<void>;
    retryable?: (err: unknown) => boolean;
  },
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    opts.signal?.throwIfAborted();
    try {
      return await attempt();
    } catch (err) {
      last = err;
      if (opts.signal?.aborted || opts.retryable?.(err) === false) throw err;
      if (i < opts.attempts - 1) await opts.sleep(500 * 2 ** i);
    }
  }
  throw last;
}
