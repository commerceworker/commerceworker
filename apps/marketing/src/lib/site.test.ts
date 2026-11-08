import { describe, expect, it } from 'vitest';
import { docsUrl, localePath, SITE_ORIGIN, socialMeta } from './site';

describe('localePath', () => {
  it('keeps English at the root and puts Spanish under /es/', () => {
    expect(localePath('en', '/')).toBe('/');
    expect(localePath('en', '/features/')).toBe('/features/');
    expect(localePath('es', '/')).toBe('/es/');
    expect(localePath('es', '/features/')).toBe('/es/features/');
    expect(localePath('es', 'features/')).toBe('/es/features/');
  });
});

describe('docsUrl', () => {
  it('links into the docs site', () => {
    expect(docsUrl('/content/')).toBe('https://docs.commerceworker.com/content/');
  });
});

describe('socialMeta', () => {
  const tags = socialMeta({ title: 'T', description: 'D', pathname: '/es/features/' });
  const get = (key: string) =>
    tags.find((t) => ('name' in t ? t.name : t.property) === key)?.content;

  it('points Open Graph at the canonical URL and the site image', () => {
    expect(get('og:url')).toBe(`${SITE_ORIGIN}/es/features/`);
    expect(get('og:image')).toBe(`${SITE_ORIGIN}/og-image.svg`);
  });

  it('carries the title and description to every network', () => {
    expect(get('description')).toBe('D');
    expect(get('og:title')).toBe('T');
    expect(get('twitter:title')).toBe('T');
    expect(get('twitter:description')).toBe('D');
  });
});
