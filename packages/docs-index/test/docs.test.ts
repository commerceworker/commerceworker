import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSource } from '../scripts/generate';
import { DOC_SEARCH_MAX_RESULTS, listDocs, readDoc, searchDocs, slugify } from '../src/index';

const generated = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'generated.ts');

describe('the embedded copy', () => {
  it('matches docs/ on disk', () => {
    // Silently stale docs are worse than no docs tool: an agent would follow
    // instructions for a version of the product that no longer exists.
    expect(readFileSync(generated, 'utf8')).toBe(buildSource());
  });

  it('covers every page', () => {
    const paths = listDocs().map((p) => p.path);
    expect(paths).toContain('api-reference');
    expect(paths).toContain('architecture');
    expect(paths.length).toBeGreaterThan(10);
  });
});

describe('listing', () => {
  it('titles each page from its own heading', () => {
    expect(listDocs().find((p) => p.path === 'api-reference')?.title).toMatch(/API/i);
  });

  it('gives an outline to navigate by, without the body', () => {
    const page = listDocs().find((p) => p.path === 'architecture');
    expect(page?.headings.length).toBeGreaterThan(3);
    expect(page).not.toHaveProperty('body');
    // The length is what tells a caller whether reading it whole is sensible.
    expect(page?.length).toBeGreaterThan(1000);
  });

  it('does not mistake shell comments for headings', () => {
    // docs/development.md fences a bash block whose comments start with `#`.
    // Read as headings, they would fill the outline with command fragments —
    // and, worse, `readDoc({ section })` would offer sections that are one
    // line of a shell script.
    const titles = listDocs()
      .find((p) => p.path === 'development')
      ?.headings.map((h) => h.title);
    expect(titles).toBeDefined();
    expect(titles).not.toContain('One package');
    expect(titles).not.toContain('Test / typecheck / lint everything');
  });
});

describe('reading', () => {
  it('returns the whole page', () => {
    expect(readDoc('architecture')?.length).toBeGreaterThan(1000);
  });

  it('is undefined for a page that does not exist', () => {
    expect(readDoc('no-such-page')).toBeUndefined();
    // Not a traversal either: paths are slugs, not filesystem paths.
    expect(readDoc('../package.json')).toBeUndefined();
  });

  it('returns one section instead of the whole page', () => {
    const page = listDocs().find((p) => p.path === 'architecture');
    const deeper = page?.headings.find((h) => h.depth === 2);
    const section = readDoc('architecture', { section: deeper?.slug });
    expect(section).toBeDefined();
    expect(section?.length).toBeLessThan((readDoc('architecture') as string).length);
    expect(section?.startsWith('##')).toBe(true);
  });

  it('stops a section at the next heading of the same level', () => {
    const page = listDocs().find((p) => p.path === 'architecture');
    const twos = page?.headings.filter((h) => h.depth === 2) ?? [];
    const [first, second] = twos;
    if (!first || !second) throw new Error('fixture needs two `##` headings');
    const section = readDoc('architecture', { section: first.slug }) as string;
    // Running past the boundary would hand back the rest of the page under the
    // wrong heading.
    expect(section).not.toContain(`## ${second.title}`);
  });

  it('is undefined for a section that does not exist', () => {
    expect(readDoc('architecture', { section: 'no-such-section' })).toBeUndefined();
  });
});

describe('searching', () => {
  it('finds a term and says where it is', () => {
    const hits = searchDocs('UUIDv7');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBeTruthy();
    expect(hits[0]?.line).toBeGreaterThan(0);
    // The nearest heading is the difference between "it is in this 30KB page"
    // and "it is in this section".
    expect(hits.some((h) => h.section)).toBe(true);
  });

  it('requires every term, not any', () => {
    const both = searchDocs('transactional outbox');
    const either = searchDocs('outbox');
    // ORing the terms returns the manual for any two-word query.
    expect(both.length).toBeLessThan(either.length);
    for (const hit of both) {
      expect(hit.snippet.toLowerCase()).toContain('transactional');
      expect(hit.snippet.toLowerCase()).toContain('outbox');
    }
  });

  it('is case-insensitive', () => {
    expect(searchDocs('uuidv7').length).toBe(searchDocs('UUIDv7').length);
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(searchDocs('')).toEqual([]);
    expect(searchDocs('   ')).toEqual([]);
  });

  it('can be confined to one page', () => {
    const hits = searchDocs('scope', { path: 'auth-and-rbac' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.path === 'auth-and-rbac')).toBe(true);
  });

  it('caps how much it will return', () => {
    // 'the' matches thousands of lines; an uncapped search would return the
    // whole corpus into an agent's context.
    expect(searchDocs('the', { limit: 5 }).length).toBe(5);
    expect(searchDocs('the', { limit: 10_000 }).length).toBe(DOC_SEARCH_MAX_RESULTS);
  });

  it('slugifies headings the way anchors are written', () => {
    expect(slugify('Adapter selection is env-driven (12-factor)')).toBe(
      'adapter-selection-is-env-driven-12-factor',
    );
    expect(slugify('`Slug` field type')).toBe('slug-field-type');
  });
});
