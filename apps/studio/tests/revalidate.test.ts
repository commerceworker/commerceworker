import { describe, expect, it } from 'vitest';
import { revalidateUnlessSearchOnly } from '~/lib/revalidate';

const args = (from: string, to: string, formMethod?: 'POST') =>
  ({
    currentUrl: new URL(from, 'http://x'),
    nextUrl: new URL(to, 'http://x'),
    formMethod,
    defaultShouldRevalidate: true,
  }) as Parameters<typeof revalidateUnlessSearchOnly>[0];

describe('a layout’s revalidation', () => {
  it('skips a change to the search alone', () => {
    expect(revalidateUnlessSearchOnly(args('/content/a?query=c', '/content/a?query=ca'))).toBe(
      false,
    );
    expect(revalidateUnlessSearchOnly(args('/content/a', '/content/a?columns=x'))).toBe(false);
  });

  it('goes on for another page, a submission or an explicit revalidate', () => {
    expect(revalidateUnlessSearchOnly(args('/content/a?query=c', '/content/b?query=c'))).toBe(true);
    expect(revalidateUnlessSearchOnly(args('/content/a', '/content/a?x=1', 'POST'))).toBe(true);
    expect(revalidateUnlessSearchOnly(args('/content/a?q=1', '/content/a?q=1'))).toBe(true);
  });
});
