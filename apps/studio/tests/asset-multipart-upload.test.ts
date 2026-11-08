import type { Asset } from '@commerceworker/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  type MultipartClient,
  type PartsProgress,
  retryable,
  SINGLE_UPLOAD_MAX_BYTES,
  uploadInParts,
  uploadsInParts,
} from '~/cms/lib/assets';
import { ApiError, UploadPartError } from '~/cms/lib/management';

/** A 20-byte file in 8-byte parts: 8, 8, then 4. */
const file = () => new File(['abcdefghijklmnopqrst'], 'film.mov', { type: 'video/quicktime' });
const PART = 8;

/**
 * The upload steps over a fake storage: each PUT is answered by `put` (an ETag, or a throw), and
 * every call is recorded in order.
 */
function fakeClient(
  put: (n: number, attempt: number) => string | Promise<string> = (n) => `"e${n}"`,
) {
  const calls: string[] = [];
  const attempts = new Map<number, number>();
  const bodies = new Map<number, string>();
  const client = {
    startAssetUpload: vi.fn(async (input: { size: number; folderId?: string }) => {
      calls.push(`start ${input.size}${input.folderId ? ` in ${input.folderId}` : ''}`);
      return {
        asset: { id: 'a1' } as Asset,
        upload: { uploadId: 'u1', partSize: PART, partCount: Math.ceil(input.size / PART) },
      };
    }),
    signAssetUploadParts: vi.fn(async (_a: string, _u: string, numbers: readonly number[]) => {
      calls.push(`sign ${numbers.join(',')}`);
      return {
        parts: numbers.map((n) => ({
          partNumber: n,
          url: `https://r2.example/${n}?try=${(attempts.get(n) ?? 0) + 1}`,
          length: n < 3 ? PART : 4,
          expiresAt: '',
        })),
      };
    }),
    putUploadPart: vi.fn(async (url: string, bytes: Blob) => {
      const n = Number(new URL(url).pathname.slice(1));
      const attempt = (attempts.get(n) ?? 0) + 1;
      attempts.set(n, attempt);
      calls.push(`put ${n} #${attempt}`);
      bodies.set(n, await bytes.text());
      return put(n, attempt);
    }),
    completeAssetUpload: vi.fn(
      async (_a: string, _u: string, parts: readonly { partNumber: number; etag: string }[]) => {
        calls.push(`complete ${parts.map((p) => `${p.partNumber}=${p.etag}`).join(' ')}`);
        return { id: 'a1', status: 'draft' } as Asset;
      },
    ),
    abortAssetUpload: vi.fn(async () => {
      calls.push('abort');
    }),
  } satisfies MultipartClient;
  return { client, calls, bodies };
}

const noWait = vi.fn(async (_ms: number) => {});

describe('uploading a large file in parts', () => {
  it('goes in parts only past one signed PUT', () => {
    expect(uploadsInParts(SINGLE_UPLOAD_MAX_BYTES)).toBe(false);
    expect(uploadsInParts(SINGLE_UPLOAD_MAX_BYTES + 1)).toBe(true);
  });

  it('PUTs each part’s exact bytes, reports bytes stored, then completes with every ETag', async () => {
    const { client, calls, bodies } = fakeClient();
    const progress: PartsProgress[] = [];
    const asset = await uploadInParts(client, file(), {
      folderId: 'f1',
      concurrency: 1,
      onProgress: (p) => progress.push(p),
      sleep: noWait,
    });
    expect(asset.id).toBe('a1');
    expect(calls).toEqual([
      'start 20 in f1',
      'sign 1',
      'put 1 #1',
      'sign 2',
      'put 2 #1',
      'sign 3',
      'put 3 #1',
      'complete 1="e1" 2="e2" 3="e3"',
    ]);
    expect([...bodies.entries()]).toEqual([
      [1, 'abcdefgh'],
      [2, 'ijklmnop'],
      [3, 'qrst'],
    ]);
    expect(progress.map((p) => [p.loaded, p.partsDone])).toEqual([
      [0, 0],
      [8, 1],
      [16, 2],
      [20, 3],
    ]);
    expect(progress.every((p) => p.total === 20 && p.partCount === 3)).toBe(true);
    expect(client.abortAssetUpload).not.toHaveBeenCalled();
  });

  it('signs a failed part again and retries it with backoff, saying which part is retrying', async () => {
    const { client, calls } = fakeClient((n, attempt) => {
      if (n === 2 && attempt < 3) throw new UploadPartError(403, 'expired');
      return `"e${n}"`;
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const progress: PartsProgress[] = [];
    await uploadInParts(client, file(), {
      concurrency: 1,
      sleep,
      onProgress: (p) => progress.push(p),
    });
    // A fresh signature for every attempt: a retry may outlast the URL it failed on.
    expect(calls.filter((c) => c.startsWith('sign 2') || c.startsWith('put 2'))).toEqual([
      'sign 2',
      'put 2 #1',
      'sign 2',
      'put 2 #2',
      'sign 2',
      'put 2 #3',
    ]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000]);
    expect(progress.some((p) => p.retryingPart === 2)).toBe(true);
    // Once it lands, nothing is retrying.
    expect(progress.at(-1)).toMatchObject({ loaded: 20, partsDone: 3, retryingPart: null });
    expect(calls.at(-1)).toBe('complete 1="e1" 2="e2" 3="e3"');
  });

  it('gives up after its attempts, aborts the upload on the server, and rejects', async () => {
    const { client, calls } = fakeClient((n) => {
      if (n === 3) throw new UploadPartError(500, 'storage down');
      return `"e${n}"`;
    });
    const err = await uploadInParts(client, file(), {
      concurrency: 1,
      attempts: 3,
      sleep: noWait,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadPartError);
    expect(calls.filter((c) => c.startsWith('put 3'))).toHaveLength(3);
    expect(calls.at(-1)).toBe('abort');
    expect(client.completeAssetUpload).not.toHaveBeenCalled();
  });

  it('doesn’t retry a refusal by the API (a sign the upload is gone), and aborts', async () => {
    const { client, calls } = fakeClient();
    client.signAssetUploadParts.mockRejectedValueOnce(new ApiError(404, 'no such upload'));
    await expect(
      uploadInParts(client, file(), { concurrency: 1, sleep: noWait }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toEqual(['start 20', 'abort']);
  });

  it('stops on cancel: no more parts go, and the upload is aborted on the server', async () => {
    const controller = new AbortController();
    const { client, calls } = fakeClient((n) => {
      // The person cancels while part 1 is in flight.
      if (n === 1) controller.abort();
      return `"e${n}"`;
    });
    const err = await uploadInParts(client, file(), {
      concurrency: 1,
      signal: controller.signal,
      sleep: noWait,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe('AbortError');
    expect(calls.filter((c) => c.startsWith('put'))).toEqual(['put 1 #1']);
    expect(calls.at(-1)).toBe('abort');
    expect(client.completeAssetUpload).not.toHaveBeenCalled();
  });

  it('keeps several parts in flight at once, up to its concurrency', async () => {
    let inFlight = 0;
    let most = 0;
    const { client } = fakeClient(async (n) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return `"e${n}"`;
    });
    await uploadInParts(client, file(), { concurrency: 2, sleep: noWait });
    expect(most).toBe(2);
  });

  it('retries what can pass by itself, and not what won’t', () => {
    expect(retryable(new UploadPartError(403, 'expired signature'))).toBe(true);
    expect(retryable(new ApiError(503, 'unavailable'))).toBe(true);
    expect(retryable(new ApiError(429, 'slow down'))).toBe(true);
    expect(retryable(new TypeError('Failed to fetch'))).toBe(true);
    expect(retryable(new ApiError(404, 'gone'))).toBe(false);
    expect(retryable(new ApiError(422, 'too big'))).toBe(false);
    expect(retryable(new DOMException('cancelled', 'AbortError'))).toBe(false);
  });
});
