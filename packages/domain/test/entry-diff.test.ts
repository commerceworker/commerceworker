import { describe, expect, it } from 'vitest';
import { alignByKey, editScript, MAX_DIFF_EDITS, tokenize } from '../src/entry/sequence-diff';
import {
  type ContentType,
  diffEntryFields,
  diffRichText,
  diffText,
  diffValue,
  type FieldDefinition,
  type FieldDiff,
  type RichTextNode,
  type TextSegment,
  type ValueDiff,
} from '../src/index';

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const type = (fields: FieldDefinition[]): ContentType => ({
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  fields,
  version: 1,
  status: 'published',
});

/** The text a segment list reads as from one side. */
const side = (segments: readonly TextSegment[], which: 'before' | 'after') =>
  segments
    .filter((s) => s.kind === 'unchanged' || s.kind === (which === 'before' ? 'removed' : 'added'))
    .map((s) => s.text)
    .join('');

const detail = <T extends ValueDiff['type']>(d: ValueDiff | undefined, t: T) => {
  expect(d?.type).toBe(t);
  return d as Extract<ValueDiff, { type: T }>;
};

const only = (diffs: FieldDiff[], apiId: string) => {
  const f = diffs.find((d) => d.field === apiId);
  if (!f) throw new Error(`no diff for ${apiId}`);
  return f;
};

// --- primitives ---------------------------------------------------------------

describe('edit script', () => {
  it('finds a shortest script that rebuilds both sides', () => {
    // A small deterministic generator, so a failure reproduces.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: rand(12) }, () => 'abcd'[rand(4)] as string);
      const b = Array.from({ length: rand(12) }, () => 'abcd'[rand(4)] as string);
      const steps = editScript(a, b, (x, y) => x === y);
      expect(steps).not.toBeNull();
      const fromA = steps?.filter(([i]) => i >= 0).map(([i]) => a[i]);
      const fromB = steps?.filter(([, j]) => j >= 0).map(([, j]) => b[j]);
      expect(fromA).toEqual(a);
      expect(fromB).toEqual(b);
      for (const [i, j] of steps ?? []) if (i >= 0 && j >= 0) expect(a[i]).toBe(b[j]);
    }
  });

  it('gives up past the edit cap rather than spending unbounded memory', () => {
    const a = Array.from({ length: MAX_DIFF_EDITS }, (_, i) => `a${i}`);
    const b = Array.from({ length: MAX_DIFF_EDITS }, (_, i) => `b${i}`);
    expect(editScript(a, b, (x, y) => x === y)).toBeNull();
    expect(editScript(a, b, (x, y) => x === y, 4 * MAX_DIFF_EDITS)).not.toBeNull();
  });
});

describe('word diff', () => {
  it('splits text into words, spaces and punctuation, keeping contractions whole', () => {
    expect(tokenize("Don't stop, co-author!")).toEqual([
      "Don't",
      ' ',
      'stop',
      ',',
      ' ',
      'co-author',
      '!',
    ]);
  });

  it('marks only the words that changed', () => {
    expect(diffText('The quick brown fox', 'The slow brown fox')).toEqual([
      { kind: 'unchanged', text: 'The ' },
      { kind: 'removed', text: 'quick' },
      { kind: 'added', text: 'slow' },
      { kind: 'unchanged', text: ' brown fox' },
    ]);
  });

  it('reads as a replaced phrase when only a space survives between two edits', () => {
    const segments = diffText('the quick fox', 'a slow fox');
    expect(segments).toEqual([
      { kind: 'removed', text: 'the quick' },
      { kind: 'added', text: 'a slow' },
      { kind: 'unchanged', text: ' fox' },
    ]);
  });

  it('always rebuilds both sides, unicode included', () => {
    const pairs: [string, string][] = [
      ['', 'new'],
      ['old', ''],
      ['Grüße aus Köln.', 'Grüße aus Berlin!'],
      ['a b c d e', 'e d c b a'],
      ['line one\nline two', 'line one\nline 2\nline three'],
    ];
    for (const [before, after] of pairs) {
      const segments = diffText(before, after);
      expect(side(segments, 'before')).toBe(before);
      expect(side(segments, 'after')).toBe(after);
    }
  });

  it('reports a wholesale replacement for two long texts that share nothing', () => {
    const before = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(' ');
    const after = Array.from({ length: 1200 }, (_, i) => `v${i}`).join(' ');
    expect(diffText(before, after)).toEqual([
      { kind: 'removed', text: before },
      { kind: 'added', text: after },
    ]);
  });

  it('is empty for two empty strings', () => {
    expect(diffText('', '')).toEqual([]);
  });
});

describe('keyed alignment', () => {
  it('flags the fewest moves that explain a reorder', () => {
    const aligned = alignByKey(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'a'], (x) => x);
    expect(aligned.filter((x) => x.moved).map((x) => x.beforeIndex)).toEqual([0]);
  });

  it('pairs repeated keys by occurrence', () => {
    const aligned = alignByKey(['x', 'x'], ['x'], (v) => v);
    expect(aligned).toEqual([
      { beforeIndex: 0, afterIndex: 0, moved: false },
      { beforeIndex: 1, afterIndex: null, moved: false },
    ]);
  });
});

// --- fields -------------------------------------------------------------------

describe('entry diff: fields and locales', () => {
  const ct = type([
    field({ apiId: 'title', name: 'Title', type: 'Symbol', localized: true }),
    field({ apiId: 'summary', name: 'Summary', type: 'Text', position: 1 }),
    field({ apiId: 'count', name: 'Count', type: 'Integer', position: 2 }),
  ]);

  it('labels fields from the content type and keeps its order', () => {
    const diffs = diffEntryFields(
      { count: { 'en-US': 1 }, title: { 'en-US': 'A' } },
      { count: { 'en-US': 2 }, title: { 'en-US': 'A' } },
      ct,
    );
    expect(diffs.map((d) => [d.field, d.name, d.fieldType, d.kind])).toEqual([
      ['title', 'Title', 'Symbol', 'unchanged'],
      ['count', 'Count', 'Integer', 'changed'],
    ]);
    expect(only(diffs, 'title').locales[0]).not.toHaveProperty('detail');
  });

  it('reports a field added or removed as a whole', () => {
    const diffs = diffEntryFields(
      { title: { 'en-US': 'A' } },
      { summary: { 'en-US': 'New summary' } },
      ct,
    );
    expect(only(diffs, 'title')).toMatchObject({ kind: 'removed', before: { 'en-US': 'A' } });
    const added = only(diffs, 'summary');
    expect(added.kind).toBe('added');
    expect(detail(added.locales[0]?.detail, 'text').segments).toEqual([
      { kind: 'added', text: 'New summary' },
    ]);
  });

  it('diffs each locale on its own', () => {
    const diffs = diffEntryFields(
      { title: { 'en-US': 'Hello', 'de-DE': 'Hallo' } },
      { title: { 'en-US': 'Hello', 'fr-FR': 'Bonjour' } },
      ct,
    );
    const title = only(diffs, 'title');
    expect(title.kind).toBe('changed');
    expect(title.locales.map((l) => [l.locale, l.kind])).toEqual([
      ['de-DE', 'removed'],
      ['en-US', 'unchanged'],
      ['fr-FR', 'added'],
    ]);
  });

  it('treats a null value as no value', () => {
    const diffs = diffEntryFields({ count: { 'en-US': null } }, { count: { 'en-US': 3 } }, ct);
    expect(only(diffs, 'count').locales[0]?.kind).toBe('added');
  });

  it('ignores object key order when comparing', () => {
    const json = type([field({ apiId: 'meta', type: 'JSON' })]);
    const diffs = diffEntryFields(
      { meta: { 'en-US': { a: 1, b: { c: 2, d: 3 } } } },
      { meta: { 'en-US': { b: { d: 3, c: 2 }, a: 1 } } },
      json,
    );
    expect(only(diffs, 'meta').kind).toBe('unchanged');
  });

  it('diffs a field the type no longer declares by the shape of its values, after the rest', () => {
    const diffs = diffEntryFields(
      { title: { 'en-US': 'A' }, legacy: { 'en-US': 'old words here' } },
      { title: { 'en-US': 'A' }, legacy: { 'en-US': 'new words here' } },
      ct,
    );
    const legacy = diffs.at(-1) as FieldDiff;
    expect(legacy.field).toBe('legacy');
    expect(legacy).not.toHaveProperty('name');
    expect(detail(legacy.locales[0]?.detail, 'text').segments[0]).toEqual({
      kind: 'removed',
      text: 'old',
    });
  });

  it('works without a content type at all', () => {
    const diffs = diffEntryFields({ a: { 'en-US': 1 } }, { a: { 'en-US': 2 } });
    expect(detail(only(diffs, 'a').locales[0]?.detail, 'value')).toEqual({
      type: 'value',
      before: 1,
      after: 2,
    });
  });
});

describe('entry diff: scalar kinds', () => {
  it.each([
    ['Integer', 1, 2],
    ['Number', 1.5, 2.25],
    ['Boolean', false, true],
    ['Date', '2026-01-01', '2026-02-01'],
    ['Location', { lat: 1, lon: 2 }, { lat: 1, lon: 3 }],
    ['JSON', { a: [1] }, { a: [1, 2] }],
  ] as const)('shows a %s value side by side', (t, before, after) => {
    expect(diffValue(before, after, field({ apiId: 'x', type: t }))).toEqual({
      type: 'value',
      before,
      after,
    });
  });

  it('diffs a slug word by word', () => {
    const d = detail(
      diffValue('hello-world', 'hello-there', field({ apiId: 's', type: 'Slug' })),
      'text',
    );
    expect(d.segments).toEqual([
      { kind: 'removed', text: 'hello-world' },
      { kind: 'added', text: 'hello-there' },
    ]);
  });

  it('falls back to values when a text field holds something else', () => {
    expect(diffValue(1, 'one', field({ apiId: 't', type: 'Symbol' })).type).toBe('value');
  });
});

describe('entry diff: references', () => {
  const asset = field({ apiId: 'hero', type: 'Link', linkType: 'Asset' });

  it('names the asset swapped by id', () => {
    expect(
      diffValue({ id: 'a1', linkType: 'Asset' }, { id: 'a2', linkType: 'Asset' }, asset),
    ).toEqual({
      type: 'link',
      before: { id: 'a1', linkType: 'Asset' },
      after: { id: 'a2', linkType: 'Asset' },
    });
  });

  it('shows a link set or cleared', () => {
    expect(diffValue(undefined, { id: 'e1', linkType: 'Entry' }, asset)).toEqual({
      type: 'link',
      before: null,
      after: { id: 'e1', linkType: 'Entry' },
    });
  });

  it('matches an array of links by target: added, removed, moved', () => {
    const links = field({
      apiId: 'related',
      type: 'Array',
      items: { type: 'Link', linkType: 'Entry' },
    });
    const e = (id: string) => ({ id, linkType: 'Entry' });
    const list = detail(
      diffValue([e('a'), e('b'), e('c')], [e('c'), e('a'), e('d')], links),
      'list',
    );
    expect(list.items.map((i) => [i.link?.id, i.kind, i.moved ?? false])).toEqual([
      ['c', 'unchanged', true],
      ['a', 'unchanged', false],
      ['b', 'removed', false],
      ['d', 'added', false],
    ]);
  });
});

describe('entry diff: arrays', () => {
  it('matches tags by their text', () => {
    const tags = field({ apiId: 'tags', type: 'Array', items: { type: 'Symbol' } });
    const list = detail(diffValue(['news', 'tech'], ['tech', 'news', 'ai'], tags), 'list');
    expect(list.items.map((i) => [i.after ?? i.before, i.kind, i.moved ?? false])).toEqual([
      ['tech', 'unchanged', true],
      ['news', 'unchanged', false],
      ['ai', 'added', false],
    ]);
  });

  it('pairs keyless components by content, editing the one that changed in place', () => {
    const cards = field({
      apiId: 'cards',
      type: 'Array',
      items: {
        type: 'Component',
        fields: [field({ apiId: 'label', name: 'Label', type: 'Symbol' })],
      },
    });
    const list = detail(
      diffValue(
        [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }],
        [{ label: 'One' }, { label: 'Two!' }, { label: 'Three' }],
        cards,
      ),
      'list',
    );
    expect(list.items.map((i) => i.kind)).toEqual(['unchanged', 'changed', 'unchanged']);
    const changed = detail(list.items[1]?.detail, 'component');
    expect(changed.fields).toEqual([
      expect.objectContaining({ field: 'label', name: 'Label', kind: 'changed' }),
    ]);
    expect(detail(changed.fields[0]?.detail, 'text').segments).toEqual([
      { kind: 'unchanged', text: 'Two' },
      { kind: 'added', text: '!' },
    ]);
  });

  it('sees a keyless component that moved unchanged as a move', () => {
    const cards = field({
      apiId: 'cards',
      type: 'Array',
      items: { type: 'Component', fields: [] },
    });
    const list = detail(diffValue([{ a: 1 }, { b: 2 }], [{ b: 2 }, { a: 1 }], cards), 'list');
    expect(list.items.filter((i) => i.moved)).toHaveLength(1);
    expect(list.items.every((i) => i.kind === 'unchanged')).toBe(true);
  });
});

describe('entry diff: blocks', () => {
  const blocks = field({
    apiId: 'body',
    name: 'Body',
    type: 'Array',
    items: {
      type: 'Component',
      variants: [
        {
          apiId: 'hero',
          name: 'Hero',
          fields: [field({ apiId: 'heading', name: 'Heading', type: 'Symbol' })],
        },
        {
          apiId: 'cta',
          name: 'Call to action',
          fields: [
            field({ apiId: 'label', name: 'Label', type: 'Symbol' }),
            field({
              apiId: 'target',
              name: 'Target',
              type: 'Link',
              linkType: 'Entry',
              position: 1,
            }),
          ],
        },
      ],
    },
  });
  const hero = (key: string, heading: string) => ({ _type: 'hero', _key: key, heading });
  const cta = (key: string, label: string) => ({ _type: 'cta', _key: key, label });

  it('matches blocks by key and diffs a changed one with its variant fields', () => {
    const list = detail(
      diffValue(
        [hero('k1', 'Welcome'), cta('k2', 'Buy')],
        [hero('k1', 'Welcome home'), cta('k2', 'Buy')],
        blocks,
      ),
      'list',
    );
    expect(list.items.map((i) => [i.key, i.variant, i.kind])).toEqual([
      ['k1', 'hero', 'changed'],
      ['k2', 'cta', 'unchanged'],
    ]);
    const fields = detail(list.items[0]?.detail, 'component').fields;
    expect(fields).toEqual([
      expect.objectContaining({ field: 'heading', name: 'Heading', kind: 'changed' }),
    ]);
  });

  it('detects a moved block, even one also edited', () => {
    const list = detail(
      diffValue(
        [hero('k1', 'A'), cta('k2', 'B'), cta('k3', 'C')],
        [cta('k3', 'C!'), hero('k1', 'A'), cta('k2', 'B')],
        blocks,
      ),
      'list',
    );
    expect(list.items.map((i) => [i.key, i.kind, i.moved ?? false])).toEqual([
      ['k3', 'changed', true],
      ['k1', 'unchanged', false],
      ['k2', 'unchanged', false],
    ]);
  });

  it('reads a block whose variant changed under the same key as one removed and one added', () => {
    const list = detail(diffValue([hero('k1', 'A')], [cta('k1', 'A')], blocks), 'list');
    expect(list.items.map((i) => [i.variant, i.kind])).toEqual([
      ['hero', 'removed'],
      ['cta', 'added'],
    ]);
  });

  it('places a removed block where it stood', () => {
    const list = detail(
      diffValue(
        [hero('k1', 'A'), cta('k2', 'B'), hero('k3', 'C')],
        [hero('k1', 'A'), hero('k3', 'C')],
        blocks,
      ),
      'list',
    );
    expect(list.items.map((i) => [i.key, i.kind])).toEqual([
      ['k1', 'unchanged'],
      ['k2', 'removed'],
      ['k3', 'unchanged'],
    ]);
  });
});

describe('entry diff: components', () => {
  const seo = field({
    apiId: 'seo',
    type: 'Component',
    fields: [
      field({ apiId: 'title', name: 'SEO title', type: 'Symbol' }),
      field({ apiId: 'image', name: 'Share image', type: 'Link', linkType: 'Asset', position: 1 }),
    ],
  });

  it('diffs nested fields by type, labelled from the definition', () => {
    const d = detail(
      diffValue(
        { title: 'Old', image: { id: 'a1', linkType: 'Asset' } },
        { title: 'New', image: { id: 'a1', linkType: 'Asset' } },
        seo,
      ),
      'component',
    );
    expect(d.fields.map((f) => [f.field, f.name, f.kind])).toEqual([
      ['title', 'SEO title', 'changed'],
      ['image', 'Share image', 'unchanged'],
    ]);
  });

  it('shows every nested field added when the component is new', () => {
    const d = detail(diffValue(undefined, { title: 'T' }, seo), 'component');
    expect(d.fields).toEqual([expect.objectContaining({ field: 'title', kind: 'added' })]);
  });
});

// --- rich text ----------------------------------------------------------------

const t = (value: string, marks: string[] = []): RichTextNode => ({
  nodeType: 'text',
  value,
  marks: marks.map((type) => ({ type })),
});
const block = (nodeType: string, ...content: RichTextNode[]): RichTextNode => ({
  nodeType,
  content,
});
const p = (text: string) => block('paragraph', t(text));
const li = (text: string, ...nested: RichTextNode[]) => block('list-item', p(text), ...nested);
const doc = (...content: RichTextNode[]) => ({ nodeType: 'document' as const, content });

describe('rich text diff', () => {
  it('keeps unchanged blocks and diffs words inside an edited paragraph', () => {
    const blocks = diffRichText(
      doc(block('heading-1', t('Title')), p('The quick brown fox.')),
      doc(block('heading-1', t('Title')), p('The quick red fox.')),
    );
    expect(blocks.map((b) => [b.nodeType, b.kind])).toEqual([
      ['heading-1', 'unchanged'],
      ['paragraph', 'changed'],
    ]);
    expect(blocks[1]?.text).toEqual([
      { kind: 'unchanged', text: 'The quick ' },
      { kind: 'removed', text: 'brown' },
      { kind: 'added', text: 'red' },
      { kind: 'unchanged', text: ' fox.' },
    ]);
  });

  it('reports added and removed paragraphs in reading order', () => {
    const blocks = diffRichText(
      doc(p('One'), p('Two'), p('Three')),
      doc(p('One'), p('Three'), p('Four')),
    );
    expect(blocks.map((b) => [b.kind, b.text.map((s) => s.text).join('')])).toEqual([
      ['unchanged', 'One'],
      ['removed', 'Two'],
      ['unchanged', 'Three'],
      ['added', 'Four'],
    ]);
  });

  it('notes a paragraph turned into a heading', () => {
    const [b] = diffRichText(doc(p('Intro')), doc(block('heading-2', t('Intro'))));
    expect(b).toMatchObject({
      kind: 'changed',
      nodeType: 'heading-2',
      beforeNodeType: 'paragraph',
    });
    expect(b?.text).toEqual([{ kind: 'unchanged', text: 'Intro' }]);
    expect(b).not.toHaveProperty('formattingChanged');
  });

  it('flags a formatting-only change', () => {
    const [b] = diffRichText(
      doc(block('paragraph', t('Bold move'))),
      doc(block('paragraph', t('Bold', ['bold']), t(' move'))),
    );
    expect(b).toMatchObject({ kind: 'changed', formattingChanged: true });
  });

  it('diffs list items one by one, with nesting depth and list type', () => {
    const blocks = diffRichText(
      doc(block('unordered-list', li('Apples'), li('Pears', block('ordered-list', li('Green'))))),
      doc(
        block(
          'unordered-list',
          li('Apples'),
          li('Bananas'),
          li('Pears', block('ordered-list', li('Green'), li('Red'))),
        ),
      ),
    );
    expect(blocks.map((b) => [b.nodeType, b.container, b.depth, b.kind, b.text[0]?.text])).toEqual([
      ['list-item', 'unordered-list', 1, 'unchanged', 'Apples'],
      ['list-item', 'unordered-list', 1, 'added', 'Bananas'],
      ['list-item', 'unordered-list', 1, 'unchanged', 'Pears'],
      ['list-item', 'ordered-list', 2, 'unchanged', 'Green'],
      ['list-item', 'ordered-list', 2, 'added', 'Red'],
    ]);
  });

  it('diffs a table by row', () => {
    const cell = (s: string) => block('table-cell', p(s));
    const row = (...cells: string[]) => block('table-row', ...cells.map(cell));
    const blocks = diffRichText(
      doc(block('table', row('Plan', 'Price'), row('Pro', '$10'))),
      doc(block('table', row('Plan', 'Price'), row('Pro', '$12'))),
    );
    expect(blocks.map((b) => [b.nodeType, b.container, b.kind])).toEqual([
      ['table-row', 'table', 'unchanged'],
      ['table-row', 'table', 'changed'],
    ]);
    expect(blocks[1]?.text).toEqual([
      { kind: 'unchanged', text: 'Pro | $' },
      { kind: 'removed', text: '10' },
      { kind: 'added', text: '12' },
    ]);
  });

  it('names the asset an embedded block swapped', () => {
    const embed = (id: string): RichTextNode => ({
      nodeType: 'embedded-asset-block',
      content: [],
      data: { target: { id, linkType: 'Asset' } },
    });
    const [b] = diffRichText(doc(embed('a1')), doc(embed('a2')));
    expect(b).toMatchObject({
      kind: 'changed',
      target: { id: 'a2', linkType: 'Asset' },
      beforeTarget: { id: 'a1', linkType: 'Asset' },
    });
  });

  it('reads an external embed as its title and URL', () => {
    const video = (url: string): RichTextNode => ({
      nodeType: 'embed',
      data: { provider: 'video', url, title: 'Launch' },
    });
    const [b] = diffRichText(doc(video('https://v.example/1')), doc(video('https://v.example/2')));
    expect(b?.kind).toBe('changed');
    expect(side(b?.text ?? [], 'after')).toBe('Launch (https://v.example/2)');
  });

  it('detects a paragraph that moved', () => {
    const blocks = diffRichText(doc(p('A'), p('B'), p('C')), doc(p('C'), p('A'), p('B')));
    expect(blocks.map((b) => [b.text[0]?.text, b.kind, b.moved ?? false])).toEqual([
      ['C', 'unchanged', true],
      ['A', 'unchanged', false],
      ['B', 'unchanged', false],
    ]);
  });

  it('treats a missing document as empty', () => {
    expect(diffRichText(undefined, doc(p('New'))).map((b) => b.kind)).toEqual(['added']);
    expect(diffRichText(doc(p('Old')), null).map((b) => b.kind)).toEqual(['removed']);
  });

  it('is what a RichText field reports, never markup', () => {
    const body = field({ apiId: 'body', type: 'RichText' });
    const d = detail(diffValue(doc(p('Hi')), doc(p('Hi there')), body), 'richText');
    expect(JSON.stringify(d)).not.toMatch(/<[a-z]/i);
    expect(d.blocks[0]?.kind).toBe('changed');
  });
});
