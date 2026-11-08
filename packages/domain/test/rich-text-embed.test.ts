import { describe, expect, it } from 'vitest';
import {
  EMBED_PROVIDERS,
  embedDataIssues,
  embedFromOEmbed,
  matchEmbedProvider,
  type RichTextDocument,
  richTextToPlainText,
  validateRichText,
} from '../src/index';

const doc = (content: RichTextDocument['content']): RichTextDocument => ({
  nodeType: 'document',
  content,
});

const embed = (data: Record<string, unknown>) => ({ nodeType: 'embed', data, content: [] });

describe('embed provider allowlist', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', 'youtube'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'youtube'],
    ['https://vimeo.com/76979871', 'vimeo'],
    ['https://vimeo.com/channels/staffpicks/76979871', 'vimeo'],
    ['https://player.vimeo.com/video/76979871', 'vimeo'],
    ['https://x.com/jack/status/20', 'x'],
    ['https://twitter.com/jack/status/20', 'x'],
    ['https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l', 'bluesky'],
    ['https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l', 'bluesky'],
    ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'spotify'],
    ['https://open.spotify.com/intl-de/episode/4uLU6hMCjMI75M1A2tKUQC', 'spotify'],
    ['https://soundcloud.com/forss/flickermood', 'soundcloud'],
    ['https://soundcloud.com/forss/sets/soulhack', 'soundcloud'],
    ['https://mastodon.social/@Gargron/109554287435185383', 'mastodon'],
    ['https://hachyderm.io/@someone@mastodon.social/111111', 'mastodon'],
    ['https://fosstodon.org/users/alice/statuses/123', 'mastodon'],
  ])('%s is %s', (url, provider) => {
    expect(matchEmbedProvider(url)?.provider.id).toBe(provider);
  });

  it.each([
    ['plain http', 'http://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['a provider that is not vetted', 'https://example.com/videos/1'],
    ['a lookalike host', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'],
    ['a provider page that is not media', 'https://www.youtube.com/feed/trending'],
    ['a malformed video id', 'https://www.youtube.com/watch?v=short'],
    ['credentials in the URL', 'https://user:pw@vimeo.com/76979871'],
    ['a non-default port', 'https://vimeo.com:8443/76979871'],
    ['a Mastodon shape on an IP literal', 'https://10.0.0.1/@alice/123'],
    ['a Mastodon shape on localhost', 'https://localhost/@alice/123'],
    ['a Mastodon shape on a named provider host', 'https://youtube.com/@alice/123'],
    ['a script URL', 'javascript:alert(1)'],
    ['not a URL', 'youtube dQw4w9WgXcQ'],
  ])('refuses %s', (_label, url) => {
    expect(matchEmbedProvider(url)).toBeUndefined();
  });

  it('gives every provider a stable id and an https oEmbed endpoint for its URLs', () => {
    const ids = EMBED_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const match = matchEmbedProvider('https://mastodon.social/@Gargron/1');
    expect(match?.provider.oembedUrl(match.url)).toBe(
      'https://mastodon.social/api/oembed?format=json&url=https%3A%2F%2Fmastodon.social%2F%40Gargron%2F1',
    );
    for (const p of EMBED_PROVIDERS) {
      expect(p.oembedUrl(new URL('https://example.com/a')).startsWith('https://')).toBe(true);
    }
  });
});

describe('embed node validation', () => {
  it('accepts a node with only url and provider (metadata is optional)', () => {
    expect(
      validateRichText(doc([embed({ url: 'https://vimeo.com/76979871', provider: 'vimeo' })])),
    ).toEqual([]);
  });

  it('accepts full metadata', () => {
    expect(
      validateRichText(
        doc([
          embed({
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            provider: 'youtube',
            kind: 'video',
            title: 'A video',
            authorName: 'Someone',
            thumbnail: {
              url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
              width: 480,
              height: 360,
            },
            width: 200,
            height: 113,
            aspectRatio: 1.7699,
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it('may sit wherever a block may, such as a list item', () => {
    const value = doc([
      {
        nodeType: 'unordered-list',
        content: [
          {
            nodeType: 'list-item',
            content: [embed({ url: 'https://x.com/jack/status/20', provider: 'x' })],
          },
        ],
      },
    ]);
    expect(validateRichText(value)).toEqual([]);
  });

  it('refuses a non-https or non-allowlisted URL', () => {
    for (const url of ['http://vimeo.com/76979871', 'https://example.com/v/1']) {
      expect(validateRichText(doc([embed({ url, provider: 'vimeo' })]))[0]).toMatch(
        /^content\[0\]: embed requires data.url, an https URL from an allowed provider/,
      );
    }
    expect(validateRichText(doc([{ nodeType: 'embed', content: [] }]))).toEqual([
      'content[0]: embed requires data { url, provider }',
    ]);
  });

  it('refuses a provider that does not own the URL', () => {
    expect(
      validateRichText(doc([embed({ url: 'https://vimeo.com/76979871', provider: 'youtube' })])),
    ).toEqual(['content[0]: embed data.provider must be "vimeo" for this URL']);
  });

  it('refuses provider markup and any other key it does not know', () => {
    const issues = embedDataIssues({
      url: 'https://vimeo.com/76979871',
      provider: 'vimeo',
      html: '<iframe src="https://player.vimeo.com/video/76979871"></iframe>',
    });
    expect(issues).toEqual(['embed data.html is not allowed']);
  });

  it('refuses malformed metadata', () => {
    const issues = embedDataIssues({
      url: 'https://vimeo.com/76979871',
      provider: 'vimeo',
      kind: 'iframe',
      title: 42,
      width: -1,
      aspectRatio: Number.POSITIVE_INFINITY,
      thumbnail: { url: 'http://i.vimeocdn.com/x.jpg' },
    });
    expect(issues).toEqual([
      'embed data.kind must be one of video, post, audio, other',
      'embed data.title must be a string of at most 500',
      'embed data.width must be an integer from 1 to 10000',
      'embed data.aspectRatio must be a positive number (width / height)',
      'embed data.thumbnail must be { url (https), width?, height? }',
    ]);
  });

  it('holds no content', () => {
    const value = doc([
      {
        nodeType: 'embed',
        data: { url: 'https://vimeo.com/76979871', provider: 'vimeo' },
        content: [{ nodeType: 'text', value: 'x' }],
      },
    ]);
    expect(validateRichText(value)).toContain('content[0]: embed holds no content');
  });
});

describe('embed plain text', () => {
  it('reads as its title and URL, or its URL alone, for search', () => {
    const value = doc([
      { nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'Watch this:' }] },
      embed({
        url: 'https://vimeo.com/76979871',
        provider: 'vimeo',
        title: 'The New Vimeo Player',
      }),
      embed({ url: 'https://x.com/jack/status/20', provider: 'x' }),
    ]);
    expect(richTextToPlainText(value)).toBe(
      'Watch this:\n\nThe New Vimeo Player (https://vimeo.com/76979871)\n\nhttps://x.com/jack/status/20',
    );
  });
});

describe('embedFromOEmbed', () => {
  const match = matchEmbedProvider('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  if (!match) throw new Error('fixture URL must match');

  it('keeps the structured metadata and never the html', () => {
    const data = embedFromOEmbed(match, {
      type: 'video',
      title: '  Never   Gonna Give You Up ',
      author_name: 'Rick Astley',
      width: 200,
      height: 113,
      thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      thumbnail_width: 480,
      thumbnail_height: 360,
      html: '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe><script>x()</script>',
      provider_url: 'https://www.youtube.com/',
    });
    expect(data).toEqual({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
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
    });
    expect(JSON.stringify(data)).not.toMatch(/iframe|script|html/);
    expect(embedDataIssues(data)).toEqual([]);
  });

  it('leaves out what is malformed, so the result always validates', () => {
    const data = embedFromOEmbed(match, {
      title: 7,
      width: '560',
      height: null,
      thumbnail_url: 'javascript:alert(1)',
    });
    expect(data).toEqual({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      provider: 'youtube',
      kind: 'video',
      width: 560,
    });
    expect(embedDataIssues(data)).toEqual([]);
    expect(embedFromOEmbed(match, 'not an object')).toEqual({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      provider: 'youtube',
      kind: 'video',
    });
  });
});
