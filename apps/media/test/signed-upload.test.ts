import { env } from 'cloudflare:workers';
import {
  createMediaUrlSigner,
  createR2BlobStore,
  handleMediaRequest,
  type R2BucketLike,
} from '@commerceworker/adapters/blob-r2';
import { describe, expect, it } from 'vitest';

/**
 * The signed upload against the real R2 binding (Miniflare's), not a stub: the create-once
 * condition (`If-None-Match: *`) is R2's to hold, so this is where it is proven.
 */
describe('a signed upload URL on R2', () => {
  const bucket = (env as unknown as { MEDIA_BUCKET: R2BucketLike }).MEDIA_BUCKET;
  const signer = createMediaUrlSigner('signed-upload-test-secret');

  it('stores once: a second PUT through the same URL is 412 and the first bytes stay', async () => {
    const key = `s/main/once-${crypto.randomUUID()}/photo.jpg`;
    const blob = createR2BlobStore(bucket, { signer, baseUrl: 'https://api.test' });
    const { url } = await blob.getUploadUrl(key, 'image/jpeg');
    const put = (body: string) =>
      handleMediaRequest(
        new Request(url, {
          method: 'PUT',
          headers: { 'content-length': String(body.length) },
          body,
        }),
        { bucket, signer },
      );
    const first = await put('first');
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBeTruthy();
    expect((await put('second')).status).toBe(412);
    expect(await (await bucket.get(key))?.text()).toBe('first');
  });
});
