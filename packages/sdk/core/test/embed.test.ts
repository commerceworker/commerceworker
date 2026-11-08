import { describe, expect, it } from 'vitest';
import { embedCard } from '../src/index.js';

const video = {
  nodeType: 'embed',
  data: {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    provider: 'youtube',
    kind: 'video',
    title: 'Never Gonna Give You Up',
    authorName: 'Rick Astley',
    thumbnail: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', width: 480, height: 360 },
  },
  content: [],
};

describe('embedCard', () => {
  it('gives a link card: href, title, provider name and a lazy, referrer-free thumbnail', () => {
    expect(embedCard(video)).toEqual({
      href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      provider: 'youtube',
      providerName: 'YouTube',
      kind: 'video',
      authorName: 'Rick Astley',
      thumbnail: {
        src: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        width: 480,
        height: 360,
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        referrerPolicy: 'no-referrer',
      },
    });
  });

  it('falls back to the URL as the title when the embed was never resolved', () => {
    expect(
      embedCard({
        nodeType: 'embed',
        data: { url: 'https://x.com/jack/status/20', provider: 'x' },
      }),
    ).toEqual({
      href: 'https://x.com/jack/status/20',
      title: 'x.com/jack/status/20',
      provider: 'x',
      providerName: 'X',
      kind: 'other',
    });
  });

  it('never links or loads anything but https', () => {
    expect(
      embedCard({ nodeType: 'embed', data: { url: 'javascript:alert(1)', provider: 'x' } }),
    ).toBeUndefined();
    const card = embedCard({
      nodeType: 'embed',
      data: { ...video.data, thumbnail: { url: 'http://tracker.example/p.gif' } },
    });
    expect(card?.thumbnail).toBeUndefined();
  });

  it('is undefined for any other node, and names a provider it does not know by its id', () => {
    expect(embedCard({ nodeType: 'paragraph', content: [] } as never)).toBeUndefined();
    expect(
      embedCard({
        nodeType: 'embed',
        data: { url: 'https://media.example/v/1', provider: 'constructor' },
      })?.providerName,
    ).toBe('constructor');
  });
});
