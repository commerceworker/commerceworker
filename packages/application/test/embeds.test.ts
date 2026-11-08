import { embedDataIssues, ValidationError } from '@commerceworker/domain';
import type { RemoteDocument, RemoteFetcher } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';
import { MAX_OEMBED_BYTES, OEMBED_TIMEOUT_MS, resolveEmbed } from '../src/index';

const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const OEMBED = {
  type: 'video',
  version: '1.0',
  title: 'Never Gonna Give You Up',
  author_name: 'Rick Astley',
  provider_name: 'YouTube',
  width: 200,
  height: 113,
  thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  thumbnail_width: 480,
  thumbnail_height: 360,
  html: '<iframe width="200" height="113" src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
};

/** Answers every GET with `answer`; records what was asked and with which limits. */
function fakeFetcher(
  answer: Partial<RemoteDocument> | (() => never) = { status: 200, body: JSON.stringify(OEMBED) },
): RemoteFetcher & { calls: { url: string; maxBytes: number; timeoutMs?: number }[] } {
  const calls: { url: string; maxBytes: number; timeoutMs?: number }[] = [];
  return {
    calls,
    async get(url, options) {
      calls.push({ url, ...options });
      if (typeof answer === 'function') answer();
      return { status: 200, body: '', ...(answer as Partial<RemoteDocument>) };
    },
    async getBytes() {
      throw new Error('resolveEmbed reads text only');
    },
  };
}

describe('resolveEmbed', () => {
  it("asks the provider's oEmbed endpoint, bounded, and keeps only the structured metadata", async () => {
    const fetcher = fakeFetcher();
    const result = await resolveEmbed(fetcher, { url: VIDEO });
    expect(fetcher.calls).toEqual([
      {
        url: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(VIDEO)}`,
        maxBytes: MAX_OEMBED_BYTES,
        timeoutMs: OEMBED_TIMEOUT_MS,
      },
    ]);
    expect(result).toEqual({
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
  });

  it("discards the provider's html, so nothing a caller stores can carry it", async () => {
    const { embed } = await resolveEmbed(fakeFetcher(), { url: VIDEO });
    expect(embed).not.toHaveProperty('html');
    expect(JSON.stringify(embed)).not.toMatch(/<iframe|<script|html/i);
    expect(embedDataIssues(embed)).toEqual([]);
  });

  it.each([
    ['plain http', 'http://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['a provider that is not allowed', 'https://example.com/watch?v=dQw4w9WgXcQ'],
    ['a script URL', 'javascript:alert(1)'],
  ])('refuses %s without fetching anything', async (_label, url) => {
    const fetcher = fakeFetcher();
    await expect(resolveEmbed(fetcher, { url })).rejects.toBeInstanceOf(ValidationError);
    expect(fetcher.calls).toEqual([]);
  });

  it.each([
    // A Mastodon URL names the host its oEmbed endpoint lives on, so the guard
    // must screen that host before the fetch.
    ['an internal name', 'https://metadata.internal/@alice/1'],
    ['a .local name', 'https://printer.local/@alice/1'],
    ['a dotted localhost', 'https://app.localhost/@alice/1'],
  ])('refuses an oEmbed endpoint on %s (SSRF) without fetching it', async (_label, url) => {
    const fetcher = fakeFetcher();
    await expect(resolveEmbed(fetcher, { url })).rejects.toThrow(ValidationError);
    expect(fetcher.calls).toEqual([]);
  });

  it("fetches a Mastodon post's own instance", async () => {
    const fetcher = fakeFetcher({
      status: 200,
      body: JSON.stringify({ type: 'rich', author_name: 'Eugen', html: '<blockquote>…' }),
    });
    const url = 'https://mastodon.social/@Gargron/109554287435185383';
    const result = await resolveEmbed(fetcher, { url });
    expect(fetcher.calls[0]?.url).toBe(
      `https://mastodon.social/api/oembed?format=json&url=${encodeURIComponent(url)}`,
    );
    expect(result).toEqual({
      resolved: true,
      embed: { url, provider: 'mastodon', kind: 'post', authorName: 'Eugen' },
    });
  });

  it.each([
    ['answers an error', fakeFetcher({ status: 404, body: '' })],
    ['redirects (not followed: the target was never screened)', fakeFetcher({ status: 302 })],
    ['sends something that is not JSON', fakeFetcher({ status: 200, body: '<html>nope' })],
    ['sends JSON that is not an object', fakeFetcher({ status: 200, body: '[1,2]' })],
    [
      'is too slow or too large (the fetcher throws)',
      fakeFetcher(() => {
        throw new Error('Response exceeds the 65536 byte limit');
      }),
    ],
  ])(
    'returns a storable embed with only url, provider and kind when the provider %s',
    async (_l, fetcher) => {
      const result = await resolveEmbed(fetcher, { url: 'https://vimeo.com/76979871' });
      expect(result).toEqual({
        resolved: false,
        embed: { url: 'https://vimeo.com/76979871', provider: 'vimeo', kind: 'video' },
      });
      expect(embedDataIssues(result.embed)).toEqual([]);
    },
  );
});
