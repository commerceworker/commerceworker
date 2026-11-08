import {
  HookRejectedError,
  InvalidStateError,
  NotConfiguredError,
  NotFoundError,
  ValidationError,
} from '@commerceworker/domain';
import type { HookDispatcher } from '@commerceworker/ports';
import {
  FakeBlobStore,
  FakeVideoHost,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createAsset,
  createSpace,
  createVideoAsset,
  getAsset,
  publishAsset,
  refreshVideoAsset,
  transformAssetUrl,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

describe('video assets', () => {
  let ctx: AppContext;
  let video: FakeVideoHost;

  beforeEach(async () => {
    video = new FakeVideoHost();
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('v'),
      video,
    };
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('creates a pending draft asset and hands back a one-time direct upload', async () => {
    const { asset, upload } = await createVideoAsset(ctx, scope, {
      fileName: 'intro.mp4',
      contentType: 'video/mp4',
      title: { 'en-US': 'Intro' },
    });
    expect(upload).toEqual({
      videoId: 'vid-1',
      uploadUrl: 'https://upload.video.local/vid-1',
      method: 'POST',
      fileField: 'file',
    });
    expect(asset.status).toBe('draft');
    expect(asset.file.video).toEqual({ provider: 'fake', videoId: 'vid-1', status: 'pending' });
    expect(await getAsset(ctx, scope, asset.id)).toEqual(asset);
    // The host gets the asset + scope so a status webhook can find it again.
    expect(video.uploads[0]).toEqual({
      videoId: 'vid-1',
      maxDurationSeconds: 3600,
      meta: { assetId: asset.id, spaceId: 'shop', environmentId: 'main', name: 'intro.mp4' },
    });
  });

  it('refresh pulls playback, poster, duration and dimensions from the host', async () => {
    const { asset } = await createVideoAsset(ctx, scope, {
      fileName: 'intro.mp4',
      contentType: 'video/mp4',
    });
    video.setVideo('vid-1', { status: 'processing' });
    expect((await refreshVideoAsset(ctx, scope, asset.id)).file.video?.status).toBe('processing');

    video.setVideo('vid-1', {
      status: 'ready',
      hlsUrl: 'https://cdn/v/manifest/video.m3u8',
      dashUrl: 'https://cdn/v/manifest/video.mpd',
      thumbnailUrl: 'https://cdn/v/thumbnails/thumbnail.jpg',
      durationSeconds: 42,
      width: 1280,
      height: 720,
    });
    const ready = await refreshVideoAsset(ctx, scope, asset.id);
    expect(ready.file).toMatchObject({
      url: 'https://cdn/v/manifest/video.m3u8',
      width: 1280,
      height: 720,
      video: {
        provider: 'fake',
        videoId: 'vid-1',
        status: 'ready',
        hlsUrl: 'https://cdn/v/manifest/video.m3u8',
        dashUrl: 'https://cdn/v/manifest/video.mpd',
        thumbnailUrl: 'https://cdn/v/thumbnails/thumbnail.jpg',
        durationSeconds: 42,
      },
    });
    // Publishing carries the playback info into the delivered snapshot.
    await publishAsset(ctx, scope, asset.id);
    const snap = await ctx.store.assets.getPublished(scope, asset.id);
    expect(snap?.file.video?.hlsUrl).toBe('https://cdn/v/manifest/video.m3u8');
  });

  it('marks the asset errored when the host reports an error or lost the video', async () => {
    const { asset } = await createVideoAsset(ctx, scope, {
      fileName: 'a.mov',
      contentType: 'video/quicktime',
    });
    video.setVideo('vid-1', { status: 'error', errorReason: 'Not a video' });
    expect((await refreshVideoAsset(ctx, scope, asset.id)).file.video).toMatchObject({
      status: 'error',
      errorReason: 'Not a video',
    });
    video.forget('vid-1');
    expect((await refreshVideoAsset(ctx, scope, asset.id)).file.video?.status).toBe('error');
  });

  it('validates content type and duration ceiling', async () => {
    await expect(
      createVideoAsset(ctx, scope, { fileName: 'x.png', contentType: 'image/png' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      createVideoAsset(ctx, scope, {
        fileName: 'x.mp4',
        contentType: 'video/mp4',
        maxDurationSeconds: 999_999,
      }),
    ).rejects.toThrow(ValidationError);
    expect(video.uploads).toHaveLength(0);
  });

  it('refuses refresh of unknown or non-video assets', async () => {
    await expect(refreshVideoAsset(ctx, scope, 'nope')).rejects.toThrow(NotFoundError);
    const { asset } = await createAsset(ctx, new FakeBlobStore(), scope, {
      fileName: 'p.png',
      contentType: 'image/png',
    });
    await expect(refreshVideoAsset(ctx, scope, asset.id)).rejects.toThrow(InvalidStateError);
  });

  it('a video asset is not an image transform target', async () => {
    const { asset } = await createVideoAsset(ctx, scope, {
      fileName: 'intro.mp4',
      contentType: 'video/mp4',
    });
    await expect(
      transformAssetUrl(ctx, new FakeBlobStore(), scope, asset.id, { width: 10 }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses before minting an upload when a hook vetoes', async () => {
    const hooks: HookDispatcher = {
      dispatch: async () => ({ veto: { hook: 'policy', reason: 'no videos' } }),
    } as unknown as HookDispatcher;
    await expect(
      createVideoAsset({ ...ctx, hooks }, scope, { fileName: 'a.mp4', contentType: 'video/mp4' }),
    ).rejects.toBeInstanceOf(HookRejectedError);
    expect(video.uploads).toHaveLength(0);
  });

  it('refuses with NotConfiguredError when no video host is bound', async () => {
    const { video: _omit, ...bare } = ctx;
    await expect(
      createVideoAsset(bare, scope, { fileName: 'a.mp4', contentType: 'video/mp4' }),
    ).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(refreshVideoAsset(bare, scope, 'x')).rejects.toBeInstanceOf(NotConfiguredError);
  });
});
