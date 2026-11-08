import { describe, expect, it } from 'vitest';
import {
  type ContentType,
  canonicalUrlIssue,
  defineContentType,
  entrySitemapUrls,
  extractReferences,
  type FieldDefinition,
  normalizeSitePath,
  reviseContentType,
  SITEMAP_MAX_URLS,
  type SiteLocation,
  sitemapFieldsOf,
  sitemapPageSize,
  ValidationError,
  validateEntryFields,
} from '../src/index';

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const title = field({ apiId: 'title', type: 'Symbol' });
const slug = field({ apiId: 'slug', type: 'Slug', position: 1 });
const seo = field({ apiId: 'seo', type: 'Seo', position: 2 });

const article = (over: Partial<ContentType> = {}): ContentType => ({
  ...defineContentType({
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    urlPattern: '/blog/{slug}',
    fields: [title, slug, seo],
  }),
  ...over,
});

const vctx = { defaultLocale: 'en-US', locales: ['en-US', 'de'] };

const messages = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return err.issues.map((i) => i.message);
    throw err;
  }
  return [];
};

describe('Seo fields on a content type', () => {
  it('may be declared once, at the top level', () => {
    expect(article().fields.map((f) => f.type)).toContain('Seo');
    expect(
      messages(() =>
        defineContentType({
          apiId: 'page',
          name: 'Page',
          displayField: 'title',
          fields: [title, seo, field({ apiId: 'meta', type: 'Seo', position: 3 })],
        }),
      ),
    ).toEqual(['A content type has at most one Seo field']);
  });

  it('is refused inside a component, as unique, or with nested fields of its own', () => {
    const inComponent = field({
      apiId: 'hero',
      type: 'Component',
      fields: [field({ apiId: 'seo', type: 'Seo' })],
    });
    expect(
      messages(() =>
        defineContentType({
          apiId: 'p',
          name: 'P',
          displayField: 'title',
          fields: [title, inComponent],
        }),
      )[0],
    ).toMatch(/cannot live inside a component/);
    expect(
      messages(() =>
        defineContentType({
          apiId: 'p',
          name: 'P',
          displayField: 'title',
          fields: [title, { ...seo, unique: true }],
        }),
      ),
    ).toEqual(['A Seo field cannot be unique']);
    expect(
      messages(() =>
        defineContentType({
          apiId: 'p',
          name: 'P',
          displayField: 'title',
          fields: [title, { ...seo, fields: [title] }],
        }),
      ),
    ).toEqual(['A Seo field cannot define nested fields']);
  });

  it('can be added to a type by revising it', () => {
    const plain = defineContentType({
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [title, slug],
    });
    expect(reviseContentType(plain, { fields: [title, slug, seo] }).fields).toHaveLength(3);
  });
});

describe('Seo values', () => {
  it('accept every part, each optional', () => {
    const fields = {
      title: { 'en-US': 'Hello' },
      seo: {
        'en-US': {
          title: 'Hello | Blog',
          description: 'A first post',
          canonicalUrl: 'https://example.com/blog/hello',
          noindex: false,
          ogImage: { id: 'a1', linkType: 'Asset' },
        },
      },
    };
    expect(validateEntryFields(article(), fields, vctx)).toEqual([]);
    expect(validateEntryFields(article(), { seo: { 'en-US': {} } }, vctx)).toEqual([]);
  });

  it('report a wrong part by its path', () => {
    const issues = validateEntryFields(
      article(),
      {
        seo: {
          'en-US': {
            title: 'x'.repeat(201),
            noindex: 'yes',
            canonicalUrl: 'javascript:alert(1)',
            keywords: 'cms',
          },
        },
      },
      vctx,
    );
    expect(issues.map((i) => i.field).sort()).toEqual([
      'seo.canonicalUrl',
      'seo.keywords',
      'seo.noindex',
      'seo.title',
    ]);
    expect(validateEntryFields(article(), { seo: { 'en-US': 'Hello' } }, vctx)).toEqual([
      { field: 'seo', locale: 'en-US', message: 'Expected an object of nested field values' },
    ]);
  });

  it('take a canonical path or an absolute http(s) URL, nothing else', () => {
    expect(canonicalUrlIssue('/blog/hello')).toBeNull();
    expect(canonicalUrlIssue('https://example.com/a?b=c')).toBeNull();
    expect(canonicalUrlIssue('http://localhost:4321/a')).toBeNull();
    for (const bad of [
      'blog/hello',
      '//evil.example/a',
      'javascript:alert(1)',
      'ftp://x/y',
      '/a b',
    ]) {
      expect(canonicalUrlIssue(bad), bad).not.toBeNull();
    }
  });

  it('count their social image as a reference to the asset', () => {
    expect(
      extractReferences(
        'e1',
        { seo: { 'en-US': { ogImage: { id: 'img', linkType: 'Asset' } } } },
        article(),
      ),
    ).toEqual([{ fromEntryId: 'e1', fromField: 'seo', toId: 'img', toType: 'Asset' }]);
  });
});

describe('entrySitemapUrls', () => {
  const en = { defaultLocale: 'en-US', locales: ['en-US'] };
  const two = { defaultLocale: 'en-US', locales: ['en-US', 'de'] };

  it('lists the entry at its pattern’s path', () => {
    expect(
      entrySitemapUrls(article(), { id: 'e1', fields: { slug: { 'en-US': 'hello' } } }, en),
    ).toEqual([{ path: '/blog/hello', locale: 'en-US' }]);
  });

  it('lists nothing for a type without a pattern, or an entry without its slug', () => {
    const { urlPattern: _p, ...unrouted } = article();
    expect(
      entrySitemapUrls(unrouted, { id: 'e1', fields: { slug: { 'en-US': 'x' } } }, en),
    ).toEqual([]);
    expect(entrySitemapUrls(article(), { id: 'e1', fields: {} }, en)).toEqual([]);
  });

  it('leaves out a noindex page, in the locales that say so', () => {
    const localizedSeo = article({
      urlPattern: '/{locale}/blog/{slug}',
      fields: [title, slug, { ...seo, localized: true }],
    });
    const urls = entrySitemapUrls(
      localizedSeo,
      {
        id: 'e1',
        fields: { slug: { 'en-US': 'hello' }, seo: { de: { noindex: true } } },
      },
      two,
    );
    expect(urls).toEqual([{ path: '/en-US/blog/hello', locale: 'en-US' }]);
    expect(
      entrySitemapUrls(
        article(),
        { id: 'e1', fields: { slug: { 'en-US': 'hello' }, seo: { 'en-US': { noindex: true } } } },
        en,
      ),
    ).toEqual([]);
  });

  it('keeps a self-canonical page and drops one whose canonical copy lives elsewhere', () => {
    const at = (canonicalUrl: string, site?: SiteLocation, type = article()) =>
      entrySitemapUrls(
        type,
        { id: 'e1', fields: { slug: { 'en-US': 'hello' }, seo: { 'en-US': { canonicalUrl } } } },
        en,
        site,
      ).length;
    const site = { origin: 'https://example.com' };
    expect(at('/blog/hello')).toBe(1);
    expect(at('https://example.com/blog/hello?utm=x', site)).toBe(1);
    expect(at('/blog/other')).toBe(0);
    expect(at('https://partner.example/blog/hello', site)).toBe(0);
    // Without the site's origin an absolute canonical is judged by its path alone.
    expect(at('https://partner.example/blog/hello')).toBe(1);
  });

  it('compares a canonical URL under the site’s path prefix', () => {
    const at = (canonicalUrl: string) =>
      entrySitemapUrls(
        article(),
        { id: 'e1', fields: { slug: { 'en-US': 'hello' }, seo: { 'en-US': { canonicalUrl } } } },
        en,
        { origin: 'https://example.com', prefix: '/docs' },
      ).length;
    expect(at('https://example.com/docs/blog/hello')).toBe(1);
    expect(at('https://example.com/blog/hello')).toBe(0);
    expect(at('https://example.com/docsx/blog/hello')).toBe(0);
    // A path canonical is a site path, as the URL pattern's are: no prefix on it.
    expect(at('/blog/hello')).toBe(1);
  });

  it('compares paths in one spelling: percent-encoding and one trailing slash', () => {
    const umlaut = article({ urlPattern: '/über/{slug}' });
    const at = (canonicalUrl: string) =>
      entrySitemapUrls(
        umlaut,
        { id: 'e1', fields: { slug: { 'en-US': 'hello' }, seo: { 'en-US': { canonicalUrl } } } },
        en,
        { origin: 'https://example.com' },
      ).length;
    expect(at('https://example.com/%C3%BCber/hello')).toBe(1);
    expect(at('/über/hello')).toBe(1);
    expect(at('https://example.com/über/hello/')).toBe(1);
    expect(at('/über/hello//')).toBe(0);
    expect(normalizeSitePath('/a/')).toBe('/a');
    expect(normalizeSitePath('/')).toBe('/');
  });

  it('lists one URL per locale for a localized slug, following the fallback chain', () => {
    const localized = article({ fields: [title, { ...slug, localized: true }, seo] });
    expect(
      entrySitemapUrls(
        localized,
        { id: 'e1', fields: { slug: { 'en-US': 'hello', de: 'hallo' } } },
        two,
      ),
    ).toEqual([
      { path: '/blog/hello', locale: 'en-US' },
      { path: '/blog/hallo', locale: 'de' },
    ]);
    // German falls back to the English slug: the same path, listed once.
    expect(
      entrySitemapUrls(localized, { id: 'e1', fields: { slug: { 'en-US': 'hello' } } }, two),
    ).toEqual([{ path: '/blog/hello', locale: 'en-US' }]);
  });

  it('lists every locale for a {locale} pattern, and the default only otherwise', () => {
    const fields = { slug: { 'en-US': 'hello' } };
    expect(
      entrySitemapUrls(article({ urlPattern: '/{locale}/blog/{slug}' }), { id: 'e1', fields }, two),
    ).toEqual([
      { path: '/en-US/blog/hello', locale: 'en-US' },
      { path: '/de/blog/hello', locale: 'de' },
    ]);
    expect(entrySitemapUrls(article(), { id: 'e1', fields }, two)).toEqual([
      { path: '/blog/hello', locale: 'en-US' },
    ]);
  });

  it('reads only the pattern’s slugs and the Seo field', () => {
    expect(sitemapFieldsOf(article())).toEqual(['slug', 'seo']);
    expect(sitemapFieldsOf(article({ urlPattern: '/p/{id}' }))).toEqual(['seo']);
    const { urlPattern: _p, ...unrouted } = article();
    expect(sitemapFieldsOf(unrouted)).toEqual([]);
  });
});

describe('sitemapPageSize', () => {
  it('keeps a page under the protocol’s URL cap for any number of locales', () => {
    expect(sitemapPageSize(1)).toBe(5_000);
    expect(sitemapPageSize(20)).toBe(2_500);
    expect(sitemapPageSize(200) * 200).toBeLessThanOrEqual(SITEMAP_MAX_URLS);
    expect(sitemapPageSize(0)).toBe(5_000);
  });
});
