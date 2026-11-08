import { env, introspectWorkflowInstance } from 'cloudflare:test';
import { createMediaUrlSigner, createR2BlobStore } from '@commerceworker/adapters/blob-r2';
import {
  type AppContext,
  createAsset,
  createSpace,
  getAssetZip,
  requestAssetZip,
  ZIP_PART_BYTES,
  zipObjectKey,
} from '@commerceworker/application';
import { CloudflareAssetZipStarter } from '@commerceworker/platform/asset-zip';
import { InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { assetZipTestState } from './fixtures/asset-zip';

// The real Workflows engine (miniflare) running the zip build against the real R2 binding: the
// archive is an R2 multipart upload of 16 MiB parts, each built in its own step from ranged reads.

let seq = 0;

describe('AssetZipWorkflow on Cloudflare Workflows', () => {
  let ctx: AppContext;
  let scope: { spaceId: string; environmentId: string };
  const blob = createR2BlobStore(env.MEDIA_BUCKET as never, {
    signer: createMediaUrlSigner('zip-test-secret'),
  });
  const starter = () => new CloudflareAssetZipStarter(env.ASSET_ZIP_WF);

  beforeEach(async () => {
    seq += 1;
    scope = { spaceId: `zip${seq}`, environmentId: 'main' };
    ctx = {
      store: new InMemoryContentStore(),
      clock: { now: () => new Date() },
      ids: new SequenceIdGenerator(`zip${seq}`),
    };
    assetZipTestState.ctx = ctx;
    assetZipTestState.blob = blob;
    await createSpace(ctx, { spaceId: scope.spaceId, name: 'Zip', defaultLocale: 'en-US' });
  });

  async function upload(fileName: string, bytes: Uint8Array) {
    const { asset } = await createAsset(ctx, blob, scope, { fileName, contentType: 'video/mp4' });
    await env.MEDIA_BUCKET.put(asset.r2Key as string, bytes);
    return asset;
  }

  it('builds a multi-part archive across a file larger than a part, once per job', async () => {
    // A file that spans two parts, then a small one in the last.
    const big = new Uint8Array(ZIP_PART_BYTES + 1234).map((_, i) => i % 251);
    const a = await upload('big.mp4', big);
    const b = await upload('small.mp4', new TextEncoder().encode('tail'));
    const job = await requestAssetZip(ctx, scope, { assetIds: [a.id, b.id], name: 'Reel' });

    await using instance = await introspectWorkflowInstance(env.ASSET_ZIP_WF, `zip-${job.id}`);
    expect(await starter().start({ scope, jobId: job.id })).toBe(true);
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toMatchObject({ status: 'completed', parts: 2 });
    // A redelivered request finds the run that exists.
    expect(await starter().start({ scope, jobId: job.id })).toBe(false);

    const done = await getAssetZip(ctx, blob, scope, job.id);
    expect(done).toMatchObject({ status: 'completed', fileCount: 2, partsDone: 2, partCount: 2 });
    const object = await env.MEDIA_BUCKET.get(zipObjectKey(scope, job));
    expect(object?.size).toBe(done.totalBytes);
    const archive = new Uint8Array(await (object as R2ObjectBody).arrayBuffer());
    // The first entry's bytes sit right after its local header, intact across the part boundary.
    const view = new DataView(archive.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const dataAt = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    // Compared by hand: a deep equality over 16 MiB is too much for the test runner.
    let same = archive.byteLength >= dataAt + big.byteLength;
    for (let i = 0; same && i < big.byteLength; i++) same = archive[dataAt + i] === big[i];
    expect(same).toBe(true);
    expect(view.getUint32(archive.byteLength - 22, true)).toBe(0x06054b50);
  });

  it('marks the job failed, and leaves no upload behind, when no asset has a file', async () => {
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: 'never.mp4',
      contentType: 'video/mp4',
    });
    const job = await requestAssetZip(ctx, scope, { assetIds: [asset.id] });
    await using instance = await introspectWorkflowInstance(env.ASSET_ZIP_WF, `zip-${job.id}`);
    await starter().start({ scope, jobId: job.id });
    await instance.waitForStatus('complete');
    expect(await getAssetZip(ctx, blob, scope, job.id)).toMatchObject({
      status: 'failed',
      error: 'None of the selected assets has a file to zip',
    });
    expect(await env.MEDIA_BUCKET.head(zipObjectKey(scope, job))).toBeNull();
  });
});
