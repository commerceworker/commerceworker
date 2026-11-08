import { describe, expect, it } from 'vitest';
import {
  allTermLabels,
  resolveTermLabel,
  summarizeUsage,
  termSlug,
  uniqueTermSlug,
} from '../src/index';

const config = {
  defaultLocale: 'en-US',
  locales: ['en-US', 'de', 'de-AT', 'fr'],
  fallbacks: { 'de-AT': 'de', de: null, fr: null },
};

describe('term slugs', () => {
  it('makes one from the label, normalizing an asked-for one', () => {
    expect(termSlug('tag', 'Crème Brûlée & Co.')).toBe('creme-brulee-co');
    expect(termSlug('tag', 'ignored', ' Hello World ')).toBe('hello-world');
    expect(termSlug('concept', '日本')).toBe('concept');
    expect(termSlug('tag', 'x', '!!!')).toBeNull();
  });

  it('numbers past the taken ones', () => {
    expect(uniqueTermSlug('news', new Set())).toBe('news');
    expect(uniqueTermSlug('news', new Set(['news', 'news-2']))).toBe('news-3');
  });
});

describe('localized term labels', () => {
  const labels = { de: 'Reisen' };

  it('walks the fallback chain, ending at the default label', () => {
    expect(resolveTermLabel('Travel', labels, config, 'de')).toBe('Reisen');
    expect(resolveTermLabel('Travel', labels, config, 'de-AT')).toBe('Reisen');
    expect(resolveTermLabel('Travel', labels, config, 'fr')).toBe('Travel');
    expect(resolveTermLabel('Travel', labels, config, 'en-US')).toBe('Travel');
    expect(resolveTermLabel('Travel', labels, config, 'xx')).toBe('Travel');
  });

  it('lists every locale’s label, the default’s included', () => {
    expect(allTermLabels('Travel', labels, config)).toEqual({ de: 'Reisen', 'en-US': 'Travel' });
  });
});

describe('term usage', () => {
  const rows = [
    { kind: 'tag' as const, termId: 't1', contentTypeApiId: 'article', count: 3 },
    { kind: 'tag' as const, termId: 't1', contentTypeApiId: 'page', count: 2 },
    { kind: 'tag' as const, termId: 't2', contentTypeApiId: 'page', count: 0 },
  ];

  it('sums per term, skipping empty rows and the types left out', () => {
    expect(summarizeUsage(rows).get('t1')).toEqual({
      count: 5,
      byContentType: { article: 3, page: 2 },
    });
    expect(summarizeUsage(rows).has('t2')).toBe(false);
    expect(summarizeUsage(rows, (t) => t === 'article').get('t1')).toEqual({
      count: 3,
      byContentType: { article: 3 },
    });
  });
});
