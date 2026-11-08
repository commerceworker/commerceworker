import { describe, expect, it } from 'vitest';
import {
  defineContentType,
  extractReferences,
  extractRichTextTargets,
  isRichTextDocument,
  MAX_RICH_TEXT_BYTES,
  MAX_RICH_TEXT_DEPTH,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  RICH_TEXT_BLOCK_NODE_TYPES,
  RICH_TEXT_INLINE_NODE_TYPES,
  type RichTextDocument,
  type RichTextNode,
  richTextToPlainText,
  safeLinkUri,
  validateEntryFields,
  validateRichText,
} from '../src/index';

const ctx = { defaultLocale: 'en-US', locales: ['en-US'] };

const doc = (content: RichTextDocument['content']): RichTextDocument => ({
  nodeType: 'document',
  content,
});

const paragraph = (text: string) => ({
  nodeType: 'paragraph',
  content: [{ nodeType: 'text', value: text, marks: [{ type: 'bold' }] }],
});

const embeddedEntry = (id: string) => ({
  nodeType: 'embedded-entry-block',
  data: { target: { id, linkType: 'Entry' as const } },
  content: [],
});

describe('rich text document', () => {
  it('recognises a well-formed document', () => {
    expect(isRichTextDocument(doc([paragraph('hi')]))).toBe(true);
    expect(isRichTextDocument({ nodeType: 'paragraph' })).toBe(false);
    expect(isRichTextDocument('not a doc')).toBe(false);
  });

  it('validates node structure and reference targets', () => {
    expect(validateRichText(doc([paragraph('ok')]))).toEqual([]);
    // A text node without a string value is invalid.
    expect(
      validateRichText(doc([{ nodeType: 'paragraph', content: [{ nodeType: 'text' }] }])),
    ).not.toEqual([]);
    // A reference node missing its target is invalid.
    expect(validateRichText(doc([{ nodeType: 'embedded-entry-block' }]))).not.toEqual([]);
  });

  it('accepts every node type in the vocabulary', () => {
    const text = { nodeType: 'text', value: 'x', marks: [] };
    const target = (linkType: 'Entry' | 'Asset') => ({ target: { id: 't1', linkType } });
    const node = (nodeType: string): RichTextNode => {
      if (nodeType === 'text') return text;
      if (nodeType === 'hyperlink')
        return { nodeType, data: { uri: 'https://example.com' }, content: [text] };
      if (nodeType === 'embed') {
        return { nodeType, data: { url: 'https://youtu.be/dQw4w9WgXcQ', provider: 'youtube' } };
      }
      if (nodeType.includes('asset')) return { nodeType, data: target('Asset'), content: [] };
      if (nodeType.includes('entry')) return { nodeType, data: target('Entry'), content: [] };
      return { nodeType, content: [text] };
    };
    // Table nodes only validate in their structure, so they appear as one well-formed table.
    const tableParts = new Set(['table', 'table-row', 'table-header-cell', 'table-cell']);
    const cell = (nodeType: string): RichTextNode => ({
      nodeType,
      content: [{ nodeType: 'paragraph', content: [text] }],
    });
    const value = doc([
      ...RICH_TEXT_BLOCK_NODE_TYPES.filter((t) => !tableParts.has(t)).map(node),
      {
        nodeType: 'table',
        content: [
          { nodeType: 'table-row', content: [cell('table-header-cell'), cell('table-cell')] },
        ],
      },
      { nodeType: 'paragraph', content: RICH_TEXT_INLINE_NODE_TYPES.map(node) },
    ]);
    expect(validateRichText(value)).toEqual([]);
  });

  it('refuses a node type outside the vocabulary, wherever it sits', () => {
    expect(validateRichText(doc([{ nodeType: 'script', content: [] }]))).toEqual([
      'content[0]: unknown nodeType "script"',
    ]);
    const nested = doc([
      {
        nodeType: 'paragraph',
        content: [{ nodeType: 'footnote-ref', data: { note: 'n1' }, content: [] }],
      },
    ]);
    expect(validateRichText(nested)).toEqual([
      'content[0].content[0]: unknown nodeType "footnote-ref"',
    ]);
    // A second root inside the tree is not a node type either.
    expect(validateRichText(doc([{ nodeType: 'document', content: [] }]))).not.toEqual([]);
  });

  it('refuses malformed content and data instead of throwing', () => {
    expect(validateRichText(doc([{ nodeType: 'paragraph', content: 'oops' } as never]))).toEqual([
      'content[0]: content must be an array',
    ]);
    expect(validateRichText(doc([{ nodeType: 'paragraph', data: 'x' } as never]))).toEqual([
      'content[0]: data must be an object',
    ]);
    expect(validateRichText(doc([null as never]))).toEqual([
      'content[0]: node is missing a nodeType',
    ]);
  });

  it('requires a hyperlink to carry a safe uri', () => {
    const link = (data: Record<string, unknown> | undefined) =>
      doc([
        {
          nodeType: 'paragraph',
          content: [{ nodeType: 'hyperlink', data, content: [{ nodeType: 'text', value: 'x' }] }],
        },
      ]);
    for (const uri of [
      'https://example.com/a?b=1&c=2',
      'mailto:a@example.com',
      '/relative',
      '#top',
    ])
      expect(validateRichText(link({ uri })), uri).toEqual([]);
    for (const data of [
      undefined,
      {},
      { uri: '' },
      { uri: 42 },
      { uri: 'javascript:alert(1)' },
      { uri: ' JaVaScRiPt:alert(1)' },
      { uri: 'java\tscript:alert(1)' },
      { uri: 'data:text/html,<script>alert(1)</script>' },
      { uri: 'vbscript:msgbox' },
      { uri: 'javascript&colon;alert(1)' },
    ]) {
      expect(validateRichText(link(data)), JSON.stringify(data)).toEqual([
        'content[0].content[0]: hyperlink requires data.uri with an http, https, mailto or tel URI',
      ]);
    }
  });

  it('shares one link-safety rule with the HTML import', () => {
    expect(safeLinkUri('  https://example.com  ')).toBe('https://example.com');
    expect(safeLinkUri('javascript:alert(1)')).toBeUndefined();
    expect(safeLinkUri(undefined)).toBeUndefined();
  });

  it('caps serialized size', () => {
    const big = 'x'.repeat(MAX_RICH_TEXT_BYTES);
    expect(validateRichText(doc([paragraph(big)]))).toEqual([
      `Rich text exceeds ${MAX_RICH_TEXT_BYTES} bytes`,
    ]);
    expect(validateRichText(doc([paragraph('x'.repeat(MAX_RICH_TEXT_BYTES / 2))]))).toEqual([]);
  });

  it('caps nesting depth', () => {
    const nest = (levels: number): RichTextNode => {
      let node: RichTextNode = {
        nodeType: 'paragraph',
        content: [{ nodeType: 'text', value: 'x' }],
      };
      for (let i = 1; i < levels; i++) node = { nodeType: 'blockquote', content: [node] };
      return node;
    };
    // The text node sits one level below the innermost paragraph.
    expect(validateRichText(doc([nest(MAX_RICH_TEXT_DEPTH - 1)]))).toEqual([]);
    const issues = validateRichText(doc([nest(MAX_RICH_TEXT_DEPTH)]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(`nodes nest more than ${MAX_RICH_TEXT_DEPTH} deep`);
    // Far past the cap: refused, not a stack overflow.
    expect(validateRichText(doc([nest(10_000)]))).not.toEqual([]);
  });

  it('extracts embedded entry/asset targets (deep)', () => {
    const value = doc([
      paragraph('intro'),
      {
        nodeType: 'blockquote',
        content: [
          embeddedEntry('e2'),
          {
            nodeType: 'asset-hyperlink',
            data: { target: { id: 'a1', linkType: 'Asset' } },
            content: [],
          },
        ],
      },
    ]);
    expect(extractRichTextTargets(value)).toEqual([
      { id: 'e2', linkType: 'Entry' },
      { id: 'a1', linkType: 'Asset' },
    ]);
  });
});

const cell = (
  text: string,
  nodeType = 'table-cell',
  data: Record<string, unknown> = {},
): RichTextNode => ({
  nodeType,
  data,
  content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: text }] }],
});
const row = (...cells: RichTextNode[]): RichTextNode => ({
  nodeType: 'table-row',
  data: {},
  content: cells,
});
const table = (...rows: RichTextNode[]): RichTextNode => ({
  nodeType: 'table',
  data: {},
  content: rows,
});

describe('rich text tables', () => {
  const pricing = table(
    row(cell('Plan', 'table-header-cell'), cell('Price', 'table-header-cell')),
    row(cell('Starter'), cell('$0')),
    row(cell('Team'), cell('$20')),
  );

  it('accepts a well-formed table, header cells and spans included', () => {
    expect(validateRichText(doc([pricing]))).toEqual([]);
    const merged = table(row(cell('Both', 'table-cell', { colspan: 2, rowspan: 1 })));
    expect(validateRichText(doc([merged]))).toEqual([]);
  });

  it('accepts a table nested in a cell, and a reference inside a cell', () => {
    const outer = table(
      row({ nodeType: 'table-cell', data: {}, content: [table(row(cell('inner')))] }),
      row({ nodeType: 'table-cell', data: {}, content: [embeddedEntry('e9')] }),
    );
    expect(validateRichText(doc([outer]))).toEqual([]);
    expect(extractRichTextTargets(doc([outer]))).toEqual([{ id: 'e9', linkType: 'Entry' }]);
  });

  it('rejects a table without rows, or with something other than rows', () => {
    expect(validateRichText(doc([table()]))).toEqual([
      'content[0]: table must have at least one table-row',
    ]);
    expect(validateRichText(doc([table(cell('loose') as RichTextNode)]))).toEqual([
      'content[0].content[0]: a table holds only table-row nodes',
    ]);
  });

  it('rejects an empty row, and a row holding something other than cells', () => {
    expect(validateRichText(doc([table(row())]))).toEqual([
      'content[0].content[0]: table-row must have at least one cell',
    ]);
    expect(validateRichText(doc([table(row(paragraph('not a cell')))]))).toEqual([
      'content[0].content[0].content[0]: a table-row holds only table-header-cell or table-cell nodes',
    ]);
  });

  it('rejects a cell holding inline content or nothing at all', () => {
    const inline = {
      nodeType: 'table-cell',
      data: {},
      content: [{ nodeType: 'text', value: 'bare' }],
    };
    expect(validateRichText(doc([table(row(inline))]))).toEqual([
      'content[0].content[0].content[0].content[0]: a table cell holds blocks, not text; wrap it in a paragraph',
    ]);
    const empty = { nodeType: 'table-header-cell', data: {}, content: [] };
    expect(validateRichText(doc([table(row(empty))]))).toEqual([
      'content[0].content[0].content[0]: table-header-cell must hold at least one block',
    ]);
  });

  it('rejects rows and cells outside a table', () => {
    expect(validateRichText(doc([row(cell('a'))]))).toEqual([
      'content[0]: table-row must be inside a table',
    ]);
    expect(validateRichText(doc([cell('a')]))).toEqual([
      'content[0]: table-cell must be inside a table-row',
    ]);
    // A row smuggled into a cell is a stray too, reported once.
    const smuggled = table(row({ nodeType: 'table-cell', data: {}, content: [row(cell('x'))] }));
    expect(validateRichText(doc([smuggled]))).toEqual([
      'content[0].content[0].content[0].content[0]: table-row must be inside a table',
    ]);
  });

  it('rejects spans that are not positive integers within bounds', () => {
    for (const data of [{ colspan: 0 }, { rowspan: 1.5 }, { colspan: '2' }, { colspan: 51 }]) {
      expect(validateRichText(doc([table(row(cell('x', 'table-cell', data)))]))).toHaveLength(1);
    }
  });

  it('bounds the rows and the cells in a row', () => {
    const tall = table(...Array.from({ length: MAX_TABLE_ROWS + 1 }, () => row(cell('r'))));
    expect(validateRichText(doc([tall]))).toEqual([
      `content[0]: table has ${MAX_TABLE_ROWS + 1} rows (at most ${MAX_TABLE_ROWS})`,
    ]);
    const wide = table(row(...Array.from({ length: MAX_TABLE_COLUMNS + 1 }, () => cell('c'))));
    expect(validateRichText(doc([wide]))).toEqual([
      `content[0].content[0]: table-row has ${MAX_TABLE_COLUMNS + 1} cells (at most ${MAX_TABLE_COLUMNS})`,
    ]);
    const atLimit = table(
      ...Array.from({ length: MAX_TABLE_ROWS }, () =>
        row(...Array.from({ length: 2 }, () => cell('c'))),
      ),
    );
    expect(validateRichText(doc([atLimit]))).toEqual([]);
  });

  it('reads a table as one block: a line per row, cells separated', () => {
    const value = doc([paragraph('Pricing'), pricing, paragraph('Billed monthly.')]);
    expect(richTextToPlainText(value)).toBe(
      'Pricing\n\nPlan | Price\nStarter | $0\nTeam | $20\n\nBilled monthly.',
    );
  });

  it('keeps a cell on its row however many blocks and breaks it holds', () => {
    const busy: RichTextNode = {
      nodeType: 'table-cell',
      data: {},
      content: [
        {
          nodeType: 'paragraph',
          content: [
            { nodeType: 'text', value: 'one' },
            { nodeType: 'hard-break' },
            { nodeType: 'text', value: 'two' },
          ],
        },
        {
          nodeType: 'unordered-list',
          content: [{ nodeType: 'list-item', content: [paragraph('three')] }],
        },
      ],
    };
    const value = doc([table(row(cell('Notes'), busy), row(cell(''), cell('')))]);
    // The empty row says nothing, so it is not a line.
    expect(richTextToPlainText(value)).toBe('Notes | one two three');
  });
});

describe('rich text plain-text extraction', () => {
  it('joins blocks with blank lines and ignores marks', () => {
    const value = doc([
      { nodeType: 'heading-1', content: [{ nodeType: 'text', value: 'Title' }] },
      paragraph('Body text'),
    ]);
    expect(richTextToPlainText(value)).toBe('Title\n\nBody text');
  });

  it('reads a block with inline nodes as one block', () => {
    const value = doc([
      {
        nodeType: 'paragraph',
        content: [
          { nodeType: 'text', value: 'See ' },
          {
            nodeType: 'hyperlink',
            data: { uri: 'https://example.com' },
            content: [{ nodeType: 'text', value: 'the docs' }],
          },
          { nodeType: 'text', value: ' for more.' },
        ],
      },
    ]);
    expect(richTextToPlainText(value)).toBe('See the docs for more.');
  });

  it('descends into nested block containers', () => {
    const value = doc([
      {
        nodeType: 'unordered-list',
        content: [
          {
            nodeType: 'list-item',
            content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'One' }] }],
          },
          {
            nodeType: 'list-item',
            content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'Two' }] }],
          },
        ],
      },
    ]);
    expect(richTextToPlainText(value)).toBe('One\n\nTwo');
  });

  it('renders hard breaks as newlines within a block', () => {
    const value = doc([
      {
        nodeType: 'paragraph',
        content: [
          { nodeType: 'text', value: 'line one' },
          { nodeType: 'hard-break' },
          { nodeType: 'text', value: 'line two' },
        ],
      },
    ]);
    expect(richTextToPlainText(value)).toBe('line one\nline two');
  });

  it('keeps a paragraph made only of hyperlinks as one block', () => {
    const value = doc([
      {
        nodeType: 'paragraph',
        content: [
          {
            nodeType: 'hyperlink',
            data: { uri: 'https://a' },
            content: [{ nodeType: 'text', value: 'Read' }],
          },
          {
            nodeType: 'hyperlink',
            data: { uri: 'https://b' },
            content: [{ nodeType: 'text', value: ' more' }],
          },
        ],
      },
    ]);
    expect(richTextToPlainText(value)).toBe('Read more');
  });

  it('embeds contribute nothing; non-documents yield empty', () => {
    expect(richTextToPlainText(doc([embeddedEntry('e1'), paragraph('after')]))).toBe('after');
    expect(richTextToPlainText('plain string')).toBe('');
    expect(richTextToPlainText(undefined)).toBe('');
    expect(richTextToPlainText(doc([]))).toBe('');
  });
});

describe('rich text in the content model', () => {
  const article = defineContentType({
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      {
        apiId: 'body',
        name: 'Body',
        type: 'RichText',
        localized: false,
        required: false,
        position: 1,
      },
    ],
  });

  it('rejects an invalid rich-text field value', () => {
    const issues = validateEntryFields(
      article,
      { title: { 'en-US': 'T' }, body: { 'en-US': { nodeType: 'paragraph' } } },
      ctx,
    );
    expect(issues.some((i) => i.field === 'body')).toBe(true);
  });

  it('refuses a script link and an unknown node on every entry write', () => {
    const body = doc([
      {
        nodeType: 'paragraph',
        content: [
          {
            nodeType: 'hyperlink',
            data: { uri: 'javascript:alert(1)' },
            content: [{ nodeType: 'text', value: 'click' }],
          },
        ],
      },
      { nodeType: 'iframe', content: [] },
    ]);
    const issues = validateEntryFields(
      article,
      { title: { 'en-US': 'T' }, body: { 'en-US': body } },
      ctx,
    );
    expect(issues.filter((i) => i.field === 'body')).toHaveLength(2);
  });

  it('extracts references embedded in a rich-text body', () => {
    const edges = extractReferences(
      'e1',
      { title: { 'en-US': 'T' }, body: { 'en-US': doc([embeddedEntry('e2')]) } },
      article,
    );
    expect(edges).toEqual([{ fromEntryId: 'e1', fromField: 'body', toId: 'e2', toType: 'Entry' }]);
  });
});
