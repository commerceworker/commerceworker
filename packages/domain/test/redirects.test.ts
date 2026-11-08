import { describe, expect, it } from 'vitest';
import {
  analyzeRedirects,
  checkRedirect,
  checkUrlPattern,
  collapseRedirectChains,
  createRedirectMatcher,
  defineContentType,
  type FieldDefinition,
  matchRedirect,
  normalizeRedirectDestination,
  normalizeRedirectSource,
  parseCsv,
  planSlugRedirects,
  type Redirect,
  redirectSetError,
  redirectsFromCsv,
  redirectsToCsv,
  reviseContentType,
  slugMoves,
  urlPath,
  ValidationError,
} from '../src/index';

const AT = '2026-01-01T00:00:00.000Z';
let n = 0;
const r = (source: string, destination: string, over: Partial<Redirect> = {}): Redirect => ({
  id: over.id ?? `r${String(++n).padStart(4, '0')}`,
  source,
  destination,
  status: 301,
  enabled: true,
  origin: 'manual',
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const issues = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return err.issues.map((i) => i.message);
    throw err;
  }
  return [];
};

describe('redirect sources', () => {
  it('normalizes slashes and encodes as a request path does', () => {
    expect(normalizeRedirectSource(' /old//page/ ')).toBe('/old/page');
    expect(normalizeRedirectSource('/')).toBe('/');
    expect(normalizeRedirectSource('/über')).toBe('/%C3%BCber');
    expect(normalizeRedirectSource('/blog/[slug]')).toBe('/blog/[slug]');
    expect(normalizeRedirectSource('/docs/[...rest]')).toBe('/docs/[...rest]');
  });

  it('refuses what is not a plain path or a whole-segment pattern', () => {
    for (const bad of [
      'old',
      '//evil.example',
      '/a?b=1',
      '/a#x',
      '/a/../b',
      '/a b',
      '/blog/post-[slug]',
      '/[...rest]/tail',
      '/[a]/[a]',
      '/[1x]',
      `/${'a'.repeat(2050)}`,
    ]) {
      expect(() => normalizeRedirectSource(bad), bad).toThrow(ValidationError);
    }
  });
});

describe('redirect destinations', () => {
  it('takes a path or an https URL, and captures the source names', () => {
    expect(normalizeRedirectDestination('/new?x=1#top', '/old')).toBe('/new?x=1#top');
    expect(normalizeRedirectDestination('https://example.com/a', '/old')).toBe(
      'https://example.com/a',
    );
    expect(normalizeRedirectDestination('/posts/[slug]', '/blog/[slug]')).toBe('/posts/[slug]');
    expect(normalizeRedirectDestination('/n/[...rest]', '/o/[...rest]')).toBe('/n/[...rest]');
  });

  it('refuses other schemes, hosts without https, credentials and unknown captures', () => {
    for (const [bad, source] of [
      ['http://example.com', '/a'],
      ['javascript:alert(1)', '/a'],
      ['//evil.example/x', '/a'],
      ['relative', '/a'],
      ['https://user:pw@example.com/', '/a'],
      ['https:///nohost', '/a'],
      ['/x/[slug]', '/a'],
      ['/x/[rest]', '/a/[...rest]'],
      ['/x/[...slug]', '/a/[slug]'],
    ] as const) {
      expect(() => normalizeRedirectDestination(bad, source), bad).toThrow(ValidationError);
    }
  });

  it('checks status, locale and note together', () => {
    expect(checkRedirect({ source: '/a/', destination: '/b' })).toEqual({
      source: '/a',
      destination: '/b',
      status: 301,
      enabled: true,
    });
    expect(
      issues(() =>
        checkRedirect({ source: '/a', destination: '/b', status: 303, locale: 'fr' }, ['en-US']),
      ),
    ).toEqual(['A status is 301, 302, 307 or 308', '"fr" is not one of the space\'s locales']);
  });
});

describe('matching', () => {
  it('prefers an exact source over any pattern', () => {
    const set = [r('/blog/[slug]', '/posts/[slug]'), r('/blog/hello', '/hi')];
    expect(matchRedirect(set, '/blog/hello')?.location).toBe('/hi');
    expect(matchRedirect(set, '/blog/other')?.location).toBe('/posts/other');
  });

  it('prefers the most specific pattern, whatever the order given', () => {
    const set = [
      r('/[...all]', '/catch/[...all]'),
      r('/docs/[...rest]', '/d/[...rest]'),
      r('/docs/[page]', '/p/[page]'),
      r('/docs/[page]/edit', '/e/[page]'),
    ];
    for (const order of [set, [...set].reverse()]) {
      const m = createRedirectMatcher(order);
      expect(m.match('/docs/a')?.location).toBe('/p/a');
      expect(m.match('/docs/a/edit')?.location).toBe('/e/a');
      expect(m.match('/docs/a/b/c')?.location).toBe('/d/a/b/c');
      expect(m.match('/other/x')?.location).toBe('/catch/other/x');
    }
  });

  it('breaks a tie deterministically: a locale’s own, then the source, then the id', () => {
    const a = r('/[x]/z', '/one', { id: 'b' });
    const b = r('/[y]/z', '/two', { id: 'a' });
    expect(matchRedirect([a, b], '/q/z')?.location).toBe('/one');
    expect(matchRedirect([b, a], '/q/z')?.location).toBe('/one');
    const local = r('/[y]/z', '/de', { locale: 'de' });
    expect(matchRedirect([a, b, local], '/q/z', 'de')?.location).toBe('/de');
  });

  it('applies a locale’s redirects only to that locale', () => {
    const set = [r('/a', '/de-a', { locale: 'de' }), r('/a', '/any-a')];
    expect(matchRedirect(set, '/a', 'de')?.location).toBe('/de-a');
    expect(matchRedirect(set, '/a', 'fr')?.location).toBe('/any-a');
    expect(matchRedirect(set, '/a')?.location).toBe('/any-a');
    expect(matchRedirect([r('/b', '/x', { locale: 'de' })], '/b')).toBeNull();
  });

  it('skips disabled redirects, normalizes the path and carries the query along', () => {
    const set = [r('/a', '/b'), r('/c', '/d?keep=1'), r('/off', '/x', { enabled: false })];
    expect(matchRedirect(set, '/a/?utm=1')?.location).toBe('/b?utm=1');
    expect(matchRedirect(set, '/c?utm=1')?.location).toBe('/d?keep=1');
    expect(matchRedirect(set, '/off')).toBeNull();
    expect(
      matchRedirect(
        [r('/über', '/u')].map((x) => ({ ...x, source: normalizeRedirectSource(x.source) })),
        '/%C3%BCber',
      )?.location,
    ).toBe('/u');
  });

  it('needs at least one segment for a splat', () => {
    expect(matchRedirect([r('/old/[...p]', '/new/[...p]')], '/old')).toBeNull();
  });
});

describe('the set', () => {
  it('finds loops, including through patterns', () => {
    const a = r('/a', '/b', { id: 'a' });
    const b = r('/b', '/a', { id: 'b' });
    expect(analyzeRedirects([a, b]).loops).toEqual([['a', 'b']]);
    expect(analyzeRedirects([r('/x', '/x', { id: 'self' })]).loops).toEqual([['self']]);
    expect(analyzeRedirects([r('/[...p]', '/new/[...p]', { id: 'all' })]).loops).toEqual([['all']]);
    const p1 = r('/a/[x]', '/b/[x]', { id: 'p1' });
    const p2 = r('/b/[y]', '/a/[y]', { id: 'p2' });
    expect(analyzeRedirects([p1, p2]).loops).toEqual([['p1', 'p2']]);
    expect(redirectSetError(analyzeRedirects([a, b]))?.issues[0]?.message).toContain('loop');
  });

  it('ignores a disabled hop and an absolute URL', () => {
    const a = r('/a', '/b');
    const b = r('/b', '/a', { enabled: false });
    expect(analyzeRedirects([a, b]).loops).toEqual([]);
    expect(analyzeRedirects([r('/a', 'https://example.com/a'), r('/b', '/c')]).chains).toEqual([]);
  });

  it('flags chains and collapses them to where they end', () => {
    const a = r('/a', '/b', { id: 'a' });
    const b = r('/b', '/c', { id: 'b' });
    const report = analyzeRedirects([a, b]);
    expect(report.loops).toEqual([]);
    expect(report.chains).toEqual([{ id: 'a', via: ['b'], destination: '/c' }]);
    expect(collapseRedirectChains([a, b])).toEqual([{ id: 'a', destination: '/c' }]);
    expect(redirectSetError(report)).toBeNull();

    const p1 = r('/a/[x]', '/b/[x]', { id: 'p1' });
    const p2 = r('/b/[y]', '/c/[y]', { id: 'p2' });
    expect(collapseRedirectChains([p1, p2])).toEqual([{ id: 'p1', destination: '/c/[x]' }]);
  });

  it('reports a source held twice for the same locale', () => {
    const report = analyzeRedirects([
      r('/a', '/b', { id: 'x' }),
      r('/a', '/c', { id: 'y' }),
      r('/a', '/d', { id: 'z', locale: 'de' }),
    ]);
    expect(report.duplicates).toEqual([{ key: '\u0000/a', ids: ['x', 'y'] }]);
  });

  it('analyzes a full set within a sensible time', () => {
    const set = Array.from({ length: 10_000 }, (_, i) => r(`/old/${i}`, `/new/${i}`));
    set.push(r('/legacy/[...p]', '/old/[...p]'));
    const started = Date.now();
    const report = analyzeRedirects(set);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(report.loops).toEqual([]);
  });
});

describe('CSV', () => {
  it('reads quoted cells, any column order, and round-trips', () => {
    expect(parseCsv('a,"b,""c"""\r\n1,2\n')).toEqual([
      ['a', 'b,"c"'],
      ['1', '2'],
    ]);
    const rows = redirectsFromCsv(
      'destination,source,status,enabled,note\n/new,/old,302,no,"moved, again"\n',
    );
    expect(rows).toEqual([
      { source: '/old', destination: '/new', status: 302, enabled: false, note: 'moved, again' },
    ]);
    const set = [r('/a', '/b', { note: 'say "hi", ok', locale: 'de' })];
    expect(redirectsFromCsv(redirectsToCsv(set))).toEqual([
      {
        source: '/a',
        destination: '/b',
        status: 301,
        locale: 'de',
        enabled: true,
        note: 'say "hi", ok',
      },
    ]);
  });

  it('refuses a header without source or destination, and unreadable values', () => {
    expect(issues(() => redirectsFromCsv('from,to\n/a,/b'))).toEqual([
      'The CSV header has no "source" column',
    ]);
    expect(issues(() => redirectsFromCsv('source,destination,status\n/a,/b,abc'))).toEqual([
      '"abc" is not a status code',
    ]);
  });
});

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

describe('URL patterns', () => {
  const fields = [
    field({ apiId: 'title', type: 'Symbol' }),
    field({ apiId: 'slug', type: 'Slug', position: 1 }),
  ];

  it('accepts {id}, {locale} and Slug fields only', () => {
    expect(checkUrlPattern('/{locale}/blog/{slug}', fields)).toBe('/{locale}/blog/{slug}');
    expect(checkUrlPattern('/p/{id}.html', fields)).toBe('/p/{id}.html');
    for (const bad of [
      'blog/{slug}',
      '/blog/{title}',
      '/blog/{nope}',
      '/a?b',
      '/a/{slug',
      '/[x]',
    ]) {
      expect(() => checkUrlPattern(bad, fields), bad).toThrow(ValidationError);
    }
  });

  it('is kept on a revision and checked against the revised fields', () => {
    const ct = defineContentType({
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields,
      urlPattern: '/blog/{slug}',
    });
    expect(ct.urlPattern).toBe('/blog/{slug}');
    expect(reviseContentType(ct, { name: 'Posts' }).urlPattern).toBe('/blog/{slug}');
    expect(reviseContentType(ct, { urlPattern: null }).urlPattern).toBeUndefined();
    expect(() => reviseContentType(ct, { fields: [fields[0] as FieldDefinition] })).toThrow(
      ValidationError,
    );
  });

  it('builds a path per locale, or none when the slug is missing', () => {
    const entry = { id: 'e1', fields: { slug: { 'en-US': 'hello' } } };
    expect(urlPath('/{locale}/blog/{slug}', entry, 'en-US')).toBe('/en-US/blog/hello');
    expect(urlPath('/blog/{slug}', entry, 'de')).toBeNull();
  });
});

describe('slug changes', () => {
  const post = {
    urlPattern: '/blog/{slug}',
    fields: [field({ apiId: 'slug', type: 'Slug' })],
  };
  const slug = (v: string) => ({ slug: { 'en-US': v } });

  it('moves the old path to the new one, for every locale when the slug is not localized', () => {
    expect(slugMoves(post, 'e1', slug('old'), slug('new'))).toEqual([
      { source: '/blog/old', destination: '/blog/new' },
    ]);
    expect(slugMoves(post, 'e1', slug('same'), slug('same'))).toEqual([]);
    expect(slugMoves({ ...post, urlPattern: undefined }, 'e1', slug('a'), slug('b'))).toEqual([]);
    expect(slugMoves({ ...post, urlPattern: '/p/{id}' }, 'e1', slug('a'), slug('b'))).toEqual([]);
  });

  it('moves per locale when the slug is localized', () => {
    const localized = {
      ...post,
      fields: [field({ apiId: 'slug', type: 'Slug', localized: true })],
    };
    expect(
      slugMoves(
        localized,
        'e1',
        { slug: { 'en-US': 'a', de: 'x' } },
        { slug: { 'en-US': 'b', de: 'x' } },
      ),
    ).toEqual([{ source: '/blog/a', destination: '/blog/b', locale: 'en-US' }]);
  });

  it('creates the redirect, repoints what pointed at the old path, drops one away from the new', () => {
    const into = r('/older', '/blog/old', { id: 'into' });
    const away = r('/blog/new', '/elsewhere', { id: 'away' });
    let next = 0;
    const plan = planSlugRedirects(
      [into, away],
      [{ source: '/blog/old', destination: '/blog/new' }],
      { entryId: 'e1', at: AT, newId: () => `new${next++}`, count: 2 },
    );
    expect(plan.remove).toEqual(['away']);
    expect(plan.save).toEqual([
      { ...into, destination: '/blog/new' },
      expect.objectContaining({
        id: 'new0',
        source: '/blog/old',
        destination: '/blog/new',
        origin: 'slug',
        entryId: 'e1',
        status: 301,
      }),
    ]);
    // A slug changed back: the old redirect is taken over rather than duplicated.
    const back = planSlugRedirects(
      [r('/blog/a', '/blog/b', { id: 'ab' })],
      [{ source: '/blog/b', destination: '/blog/a' }],
      { entryId: 'e1', at: AT, newId: () => 'ba', count: 1 },
    );
    expect(back.remove).toEqual(['ab']);
    expect(back.save.map((x) => [x.source, x.destination])).toEqual([['/blog/b', '/blog/a']]);
  });

  it('leaves new redirects out past the cap, still repointing', () => {
    const plan = planSlugRedirects(
      [r('/older', '/blog/old', { id: 'into' })],
      [{ source: '/blog/old', destination: '/blog/new' }],
      { entryId: 'e1', at: AT, newId: () => 'x', count: 5, max: 5 },
    );
    expect(plan.save.map((x) => x.id)).toEqual(['into']);
  });
});
