import { describe, expect, it } from 'vitest';
import {
  createStreamVideoHost,
  mapStreamState,
  type StreamBindingLike,
  type StreamVideoLike,
  verifyStreamWebhook,
} from '../../src/video-stream/index';

function fakeStream(details: Record<string, StreamVideoLike>) {
  const created: unknown[] = [];
  const deleted: string[] = [];
  const stream: StreamBindingLike = {
    async createDirectUpload(params) {
      created.push(params);
      return { uploadURL: 'https://upload.videodelivery.net/abc', id: 'abc' };
    },
    video(id) {
      return {
        async details() {
          const d = details[id];
          if (!d) throw Object.assign(new Error('video not found'), { name: 'NotFoundError' });
          return d;
        },
        async delete() {
          if (!details[id]) throw Object.assign(new Error('nope'), { name: 'NotFoundError' });
          deleted.push(id);
        },
      };
    },
  };
  return { stream, created, deleted };
}

describe('createStreamVideoHost', () => {
  it('creates a direct upload with expiry + meta and returns a POST target', async () => {
    const { stream, created } = fakeStream({});
    const host = createStreamVideoHost(stream, {
      now: () => new Date('2026-01-01T00:00:00Z'),
      uploadTtlSeconds: 600,
    });
    const up = await host.createUpload({ maxDurationSeconds: 120, meta: { assetId: 'a1' } });
    expect(up).toEqual({
      videoId: 'abc',
      uploadUrl: 'https://upload.videodelivery.net/abc',
      method: 'POST',
      fileField: 'file',
    });
    expect(created[0]).toEqual({
      maxDurationSeconds: 120,
      expiry: '2026-01-01T00:10:00.000Z',
      meta: { assetId: 'a1' },
    });
  });

  it('maps details onto playback, poster, duration and dimensions', async () => {
    const { stream } = fakeStream({
      abc: {
        readyToStream: true,
        status: { state: 'ready' },
        hlsPlaybackUrl: 'https://x/manifest/video.m3u8',
        dashPlaybackUrl: 'https://x/manifest/video.mpd',
        thumbnail: 'https://x/thumbnails/thumbnail.jpg',
        duration: 12.5,
        input: { width: 1920, height: 1080 },
      },
      bad: {
        readyToStream: false,
        status: {
          state: 'error',
          errorReasonCode: 'ERR_NON_VIDEO',
          errorReasonText: 'Not a video',
        },
        duration: -1,
        input: { width: -1, height: -1 },
      },
    });
    const host = createStreamVideoHost(stream);
    expect(await host.getVideo('abc')).toEqual({
      videoId: 'abc',
      status: 'ready',
      hlsUrl: 'https://x/manifest/video.m3u8',
      dashUrl: 'https://x/manifest/video.mpd',
      thumbnailUrl: 'https://x/thumbnails/thumbnail.jpg',
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
    });
    expect(await host.getVideo('bad')).toEqual({
      videoId: 'bad',
      status: 'error',
      errorReason: 'Not a video',
    });
    expect(await host.getVideo('missing')).toBeNull();
    await expect(host.delete('missing')).resolves.toBeUndefined();
  });

  it('normalizes Stream states', () => {
    expect(mapStreamState('pendingupload', false)).toBe('pending');
    expect(mapStreamState('queued', false)).toBe('processing');
    expect(mapStreamState('inprogress', false)).toBe('processing');
    expect(mapStreamState('ready', false)).toBe('processing');
    expect(mapStreamState('ready', true)).toBe('ready');
    expect(mapStreamState('error', false)).toBe('error');
  });
});

async function sign(secret: string, time: number, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${time}.${body}`)));
  return `time=${time},sig1=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

describe('verifyStreamWebhook', () => {
  const body = JSON.stringify({ uid: 'abc', meta: { assetId: 'a1', spaceId: 's', n: 3 } });

  it('accepts a correctly signed, fresh notification and returns only id + string meta', async () => {
    const header = await sign('whsec', 1000, body);
    expect(await verifyStreamWebhook('whsec', header, body, { nowSeconds: 1010 })).toEqual({
      videoId: 'abc',
      meta: { assetId: 'a1', spaceId: 's' },
    });
  });

  it('rejects wrong secret, tampered body, stale timestamp, and missing header', async () => {
    const header = await sign('whsec', 1000, body);
    expect(await verifyStreamWebhook('other', header, body, { nowSeconds: 1000 })).toBeNull();
    expect(
      await verifyStreamWebhook('whsec', header, body.replace('a1', 'a2'), { nowSeconds: 1000 }),
    ).toBeNull();
    expect(await verifyStreamWebhook('whsec', header, body, { nowSeconds: 5000 })).toBeNull();
    expect(await verifyStreamWebhook('whsec', null, body)).toBeNull();
  });
});
