import type { ApiConfig } from '@commerceworker/platform/config';
import { FakeImageTransformer, FakeVideoHost } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda' };
const M = '/spaces/s1/environments/main';

function makeApp(opts: { video?: FakeVideoHost; images?: FakeImageTransformer } = {}) {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp({ ...ctx, ...opts }, config, rag, blob, ai);
  return app;
}

describe('video assets over HTTP', () => {
  it('creates a video upload ticket, refreshes status, and delivers playback once published', async () => {
    const video = new FakeVideoHost();
    const app = makeApp({ video });

    const created = await app.request(`${M}/assets/videos`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ fileName: 'intro.mp4', contentType: 'video/mp4' }),
    });
    expect(created.status).toBe(201);
    const { asset, upload } = (await created.json()) as {
      asset: { id: string; file: { video: { status: string } } };
      upload: { uploadUrl: string; method: string; fileField: string };
    };
    expect(upload).toMatchObject({ method: 'POST', fileField: 'file' });
    expect(asset.file.video.status).toBe('pending');

    video.setVideo('vid-1', {
      status: 'ready',
      hlsUrl: 'https://cdn/v.m3u8',
      thumbnailUrl: 'https://cdn/t.jpg',
    });
    const refreshed = await app.request(`${M}/assets/${asset.id}/video/refresh`, {
      method: 'POST',
      headers: cma,
    });
    expect(refreshed.status).toBe(200);
    expect(
      ((await refreshed.json()) as { file: { video: { status: string } } }).file.video.status,
    ).toBe('ready');

    await app.request(`${M}/assets/${asset.id}/published`, { method: 'POST', headers: cma });
    const delivered = await app.request(`/delivery/s1/main/assets/${asset.id}`, { headers: cda });
    expect(
      ((await delivered.json()) as { file: { video: { hlsUrl: string } } }).file.video.hlsUrl,
    ).toBe('https://cdn/v.m3u8');
  });

  it('requires content:write and answers 501 when no video host is bound', async () => {
    const app = makeApp();
    const denied = await app.request(`${M}/assets/videos`, {
      method: 'POST',
      headers: { ...cda, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'a.mp4', contentType: 'video/mp4' }),
    });
    expect(denied.status).toBe(403);
    const res = await app.request(`${M}/assets/videos`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ fileName: 'a.mp4', contentType: 'video/mp4' }),
    });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_configured');
  });
});

describe('image transforms over HTTP', () => {
  it('routes management + delivery transforms through the bound transformer (fm=auto)', async () => {
    const images = new FakeImageTransformer();
    const app = makeApp({ images });
    const created = await app.request(`${M}/assets`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ fileName: 'p.jpg', contentType: 'image/jpeg' }),
    });
    const { asset } = (await created.json()) as { asset: { id: string } };

    const mgmt = await app.request(`${M}/assets/${asset.id}/transform?w=300&fit=crop&fm=auto`, {
      headers: cma,
    });
    expect(mgmt.status).toBe(200);
    expect(images.calls[0]?.transform).toMatchObject({ width: 300, fit: 'crop', format: 'auto' });

    await app.request(`${M}/assets/${asset.id}/published`, { method: 'POST', headers: cma });
    const delivered = await app.request(`/delivery/s1/main/assets/${asset.id}/transform?w=50`, {
      headers: cda,
    });
    expect(delivered.status).toBe(302);
    expect(delivered.headers.get('location')).toContain('#t=');
  });
});
