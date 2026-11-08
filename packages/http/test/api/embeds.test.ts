import type { ApiConfig } from '@commerceworker/platform/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const OEMBED = {
  type: 'video',
  title: 'Never Gonna Give You Up',
  author_name: 'Rick Astley',
  width: 200,
  height: 113,
  thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  thumbnail_width: 480,
  thumbnail_height: 360,
  html: '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe><script>x()</script>',
};

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

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

let app: ReturnType<typeof createApp>;
const realFetch = globalThis.fetch;

/** Stands in for the network; installed before the app is built, which captures `fetch`. */
const withNetwork = (answer: { status: number; body: string }) => {
  const stub = vi.fn(
    async (_url: string | URL) =>
      new Response(answer.body, {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  globalThis.fetch = stub as unknown as typeof fetch;
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai);
  return stub;
};

let network: ReturnType<typeof withNetwork>;
beforeEach(() => {
  network = withNetwork({ status: 200, body: JSON.stringify(OEMBED) });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const resolve = (url: string, token = 'cma') =>
  app.request('/spaces/s1/environments/main/embeds/resolve', {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ url }),
  });

describe('resolving an embed over HTTP', () => {
  it("returns the embed node's structured data, never the provider's html", async () => {
    const res = await resolve(VIDEO);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      resolved: true,
      embed: {
        url: VIDEO,
        provider: 'youtube',
        kind: 'video',
        title: 'Never Gonna Give You Up',
        authorName: 'Rick Astley',
        thumbnail: {
          url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
          width: 480,
          height: 360,
        },
        width: 200,
        height: 113,
        aspectRatio: 1.7699,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/<iframe|<script|html/i);
    expect(String(network.mock.calls[0]?.[0])).toBe(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(VIDEO)}`,
    );
  });

  it('refuses a URL that is not https or not on an allowed provider, without fetching', async () => {
    for (const url of ['http://vimeo.com/76979871', 'https://example.com/v/1']) {
      const res = await resolve(url);
      expect(res.status).toBe(422);
      expect(JSON.stringify(await res.json())).toMatch(/allowed embed provider/);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it('refuses an oEmbed endpoint on a private name (SSRF), without fetching', async () => {
    const res = await resolve('https://metadata.internal/@alice/1');
    expect(res.status).toBe(422);
    expect(network).not.toHaveBeenCalled();
  });

  it('answers resolved: false with a storable embed when the provider fails', async () => {
    withNetwork({ status: 404, body: 'Not Found' });
    const res = await resolve('https://vimeo.com/76979871');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resolved: false,
      embed: { url: 'https://vimeo.com/76979871', provider: 'vimeo', kind: 'video' },
    });
  });

  it('needs content:write in the space', async () => {
    const res = await resolve(VIDEO, 'cda');
    expect(res.status).toBe(403);
    // A management key for this space, asked about another, is refused there.
    const other = await app.request('/spaces/s2/environments/main/embeds/resolve', {
      method: 'POST',
      headers: headers('cma'),
      body: JSON.stringify({ url: VIDEO }),
    });
    expect(other.status).toBe(403);
    expect(network).not.toHaveBeenCalled();
  });

  it('rejects a body without a url', async () => {
    const res = await app.request('/spaces/s1/environments/main/embeds/resolve', {
      method: 'POST',
      headers: headers('cma'),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    expect(network).not.toHaveBeenCalled();
  });
});
