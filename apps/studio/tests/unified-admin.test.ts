import { describe, expect, it } from 'vitest';
import { unifiedDestination, unifiedRedirect } from '~/lib/unified-admin';

describe('old Studio bookmarks', () => {
  it.each([
    ['/', '/content'],
    ['/dashboard', '/content'],
    ['/content/article/entry', '/content/entries/article/entry'],
    ['/assets', '/content/assets'],
    ['/workflows/one', '/content/workflows/one'],
    ['/settings/team', '/content/settings/team'],
    ['/account', '/account'],
    ['/team', '/team'],
    ['/oauth/authorize', '/content-api/oauth/authorize'],
    ['/oauth/device', '/content-api/oauth/device'],
  ])('moves %s to %s', (from, to) => expect(unifiedDestination(from)).toBe(to));

  it('preserves content scope and filters while dropping route-data selectors', () => {
    const response = unifiedRedirect(
      new Request(
        'https://studio.example/content/article.data?space=s1&query=hello&_routes=content',
      ),
      'https://app.example',
    );
    expect(response.headers.get('location')).toBe(
      'https://app.example/content/entries/article?space=s1&query=hello',
    );
  });

  it('does not replay old form writes or accept an external login return address', () => {
    expect(
      unifiedRedirect(
        new Request('https://studio.example/login', { method: 'POST' }),
        'https://app.example',
      ).status,
    ).toBe(410);
    expect(
      unifiedRedirect(
        new Request('https://studio.example/login?next=//evil.example'),
        'https://app.example',
      ).headers.get('location'),
    ).toBe('https://app.example/login');
  });
});
