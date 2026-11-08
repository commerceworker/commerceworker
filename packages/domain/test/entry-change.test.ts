import { describe, expect, it } from 'vitest';
import {
  type AuditDetail,
  type ContentType,
  capAuditDetail,
  changedPaths,
  diffEntryFields,
  type EntryChange,
  type EntryFields,
  type FieldDefinition,
  MAX_AUDIT_DETAIL_SIZE,
} from '../src/index';

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const model: ContentType = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'title', type: 'Symbol', localized: true }),
    field({ apiId: 'slug', type: 'Slug', position: 1 }),
    field({
      apiId: 'hero',
      type: 'Component',
      position: 2,
      fields: [
        field({ apiId: 'alt', type: 'Symbol' }),
        field({ apiId: 'credit', type: 'Symbol', position: 1 }),
        field({ apiId: 'data', type: 'JSON', position: 2 }),
      ],
    }),
    field({ apiId: 'body', type: 'RichText', position: 3, localized: true }),
    field({ apiId: 'data', type: 'JSON', position: 4 }),
    field({ apiId: 'seo', type: 'Seo', position: 5 }),
    field({ apiId: 'tags', type: 'Array', position: 6, items: { type: 'Symbol' } }),
    field({
      apiId: 'sections',
      type: 'Array',
      position: 7,
      items: { type: 'Component', fields: [field({ apiId: 'heading', type: 'Symbol' })] },
    }),
    field({ apiId: 'author', type: 'Link', linkType: 'Entry', position: 8 }),
  ],
};

const LOCALES = ['en-US', 'de'];
const SENTINEL = 'SENTINEL_d41d8c';
const en = (value: unknown) => ({ 'en-US': value });
const paths = (before: EntryFields, after: EntryFields) =>
  changedPaths(before, after, model, LOCALES).paths;

const paragraph = (text: string) => ({
  nodeType: 'document' as const,
  content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: text, marks: [] }] }],
});

describe('changedPaths', () => {
  it('names the fields that changed, in the model’s order, and no others', () => {
    expect(
      paths(
        { title: en('A'), slug: en('a'), author: en({ id: 'x', linkType: 'Entry' }) },
        { title: en('B'), slug: en('a'), author: en({ id: 'y', linkType: 'Entry' }) },
      ),
    ).toEqual(['fields.title', 'fields.author']);
  });

  it('reports nothing for a save that changed nothing', () => {
    const fields = { title: en('A'), hero: en({ alt: 'x' }) };
    expect(changedPaths(fields, fields, model, LOCALES)).toEqual({ paths: [], locales: [] });
  });

  it('treats a field that went from nothing to nothing as unchanged', () => {
    expect(paths({}, { title: en(null) })).toEqual([]);
    expect(paths({ title: {} }, {})).toEqual([]);
  });

  it('goes into a component by the model’s nested fields', () => {
    expect(
      paths(
        { hero: en({ alt: 'old', credit: 'kept' }) },
        { hero: en({ alt: 'new', credit: 'kept' }) },
      ),
    ).toEqual(['fields.hero.alt']);
  });

  it('reports a nested field added or removed, and a component added or removed whole', () => {
    expect(paths({ hero: en({ alt: 'x' }) }, { hero: en({ credit: 'y' }) })).toEqual([
      'fields.hero.alt',
      'fields.hero.credit',
    ]);
    expect(paths({}, { hero: en({ alt: 'x', credit: 'y' }) })).toEqual(['fields.hero']);
    expect(paths({ hero: en({ alt: 'x' }) }, {})).toEqual(['fields.hero']);
  });

  it('stops at the component for a nested key the model doesn’t declare', () => {
    expect(
      paths(
        { hero: en({ alt: 'x', [SENTINEL]: 1 }) },
        { hero: en({ alt: 'changed', [SENTINEL]: 2 }) },
      ),
    ).toEqual(['fields.hero']);
  });

  it('reports a rich text change as the field, never the document', () => {
    expect(
      paths({ body: en(paragraph('before')) }, { body: en(paragraph(`after ${SENTINEL}`)) }),
    ).toEqual(['fields.body']);
  });

  it('stops at a JSON field and at a Seo value: their keys are not the model’s', () => {
    expect(
      paths(
        { data: en({ a: { b: 1 } }), seo: en({ title: 'x' }) },
        { data: en({ a: { b: 2 }, [SENTINEL]: true }), seo: en({ title: 'y' }) },
      ),
    ).toEqual(['fields.data', 'fields.seo']);
    expect(
      paths({ hero: en({ data: { a: 1 } }) }, { hero: en({ data: { [SENTINEL]: 2 } }) }),
    ).toEqual(['fields.hero.data']);
  });

  it('reports a scalar list as the field', () => {
    expect(paths({ tags: en(['a', 'b']) }, { tags: en(['a', SENTINEL]) })).toEqual(['fields.tags']);
  });

  it('names an element’s changed field with [], and never its _key', () => {
    const key = `${SENTINEL}-key`;
    expect(
      paths(
        { sections: en([{ _key: key, heading: 'old' }]) },
        { sections: en([{ _key: key, heading: 'new' }]) },
      ),
    ).toEqual(['fields.sections[].heading']);
  });

  it('reports the list itself when an element came, went or moved', () => {
    const a = { _key: 'a', heading: 'A' };
    const b = { _key: 'b', heading: 'B' };
    expect(paths({ sections: en([a]) }, { sections: en([a, b]) })).toEqual(['fields.sections']);
    expect(paths({ sections: en([a, b]) }, { sections: en([a]) })).toEqual(['fields.sections']);
    expect(paths({ sections: en([a, b]) }, { sections: en([b, a]) })).toEqual(['fields.sections']);
  });

  it('counts a field the type no longer declares, and never names it', () => {
    const change = changedPaths({ [SENTINEL]: en(1), title: en('a') }, {}, model, LOCALES);
    expect(change).toEqual({ paths: ['fields.title'], locales: ['en-US'], undeclaredFields: 1 });
  });

  it('lists the locales a localized field changed in, sorted', () => {
    const change = changedPaths(
      { title: { 'en-US': 'A', de: 'B' }, body: { 'en-US': paragraph('kept') } },
      { title: { 'en-US': 'A', de: 'C' }, body: { 'en-US': paragraph('edited') } },
      model,
      LOCALES,
    );
    expect(change.locales).toEqual(['de', 'en-US']);
  });

  it('says no locale for a change to a field that isn’t localized', () => {
    expect(changedPaths({ slug: en('a') }, { slug: en('b') }, model, LOCALES).locales).toEqual([]);
  });

  it('keeps a locale key the space doesn’t have out: a localized field stores any key', () => {
    const change = changedPaths(
      { title: { 'en-US': 'A' } },
      { title: { 'en-US': 'A', [SENTINEL]: 'stored and never read' } },
      model,
      LOCALES,
    );
    expect(change).toEqual({ paths: ['fields.title'], locales: [] });
  });
});

describe('the diff a save runs', () => {
  const quick = (before: EntryFields, after: EntryFields) =>
    diffEntryFields(before, after, model, { structureOnly: true });
  const detailOf = (diffs: ReturnType<typeof quick>, field: string) =>
    diffs.find((d) => d.field === field)?.locales[0]?.detail;

  it('does no word diff of text or rich text, whatever a writer rewrites', () => {
    const diffs = quick(
      { title: en('a b c'), body: en(paragraph('old words')) },
      { title: en('x y z'), body: en(paragraph('new words')) },
    );
    expect(detailOf(diffs, 'title')?.type).toBe('value');
    expect(detailOf(diffs, 'body')?.type).toBe('value');
  });

  it('aligns no list that has no identity to align by', () => {
    const numbers: ContentType = {
      ...model,
      fields: [field({ apiId: 'n', type: 'Array', items: { type: 'Integer' } })],
    };
    const [diff] = diffEntryFields({ n: en([1, 2]) }, { n: en([3, 4]) }, numbers, {
      structureOnly: true,
    });
    expect(diff?.locales[0]?.detail?.type).toBe('value');
    expect(changedPaths({ n: en([1, 2]) }, { n: en([3, 4]) }, numbers, LOCALES).paths).toEqual([
      'fields.n',
    ]);
  });

  it('agrees with the full diff on what changed', () => {
    const before = { title: en('a'), slug: en('s'), hero: en({ alt: 'x' }), tags: en(['a']) };
    const after = { title: en('b'), slug: en('s'), hero: en({ alt: 'y' }), tags: en(['b']) };
    const kinds = (diffs: ReturnType<typeof quick>) => diffs.map((d) => [d.field, d.kind]);
    expect(kinds(quick(before, after))).toEqual(kinds(diffEntryFields(before, after, model)));
  });
});

describe('capAuditDetail', () => {
  const entry = (n: number, over: Partial<EntryChange> = {}): EntryChange => ({
    entryId: `entry-${n}`,
    contentType: 'article',
    kind: 'updated',
    version: 2,
    paths: ['fields.title'],
    locales: ['en-US'],
    ...over,
  });
  const size = (d: AuditDetail) => JSON.stringify(d).length;

  it('leaves a detail within the cap as it is', () => {
    const detail = { entries: [entry(1)] };
    expect(capAuditDetail(detail)).toBe(detail);
  });

  it('keeps what fits of a long list of paths, and says it stopped', () => {
    const many = Array.from({ length: 500 }, (_, i) => `fields.${'f'.repeat(50)}${i}`);
    const capped = capAuditDetail({ entries: [entry(1, { paths: many })] });
    expect(size(capped)).toBeLessThanOrEqual(MAX_AUDIT_DETAIL_SIZE);
    expect(capped.truncated).toBe(true);
    expect(capped.entries[0]?.paths.length).toBeGreaterThan(0);
    expect(many.slice(0, capped.entries[0]?.paths.length)).toEqual(capped.entries[0]?.paths);
    expect(capped.entries[0]?.locales).toEqual(['en-US']);
  });

  it('drops the entries that don’t fit at all', () => {
    const entries = Array.from({ length: 200 }, (_, n) => entry(n));
    const capped = capAuditDetail({ entries });
    expect(size(capped)).toBeLessThanOrEqual(MAX_AUDIT_DETAIL_SIZE);
    expect(capped.truncated).toBe(true);
    expect(capped.entries.length).toBeLessThan(200);
    expect(capped.entries[0]?.entryId).toBe('entry-0');
  });

  it('keeps a detail that is already marked, within the cap', () => {
    const paths = Array.from({ length: 500 }, (_, i) => `fields.field${i}`);
    const capped = capAuditDetail({ entries: [entry(1, { paths })], truncated: true });
    expect(size(capped)).toBeLessThanOrEqual(MAX_AUDIT_DETAIL_SIZE);
    expect(capped.truncated).toBe(true);
  });
});
