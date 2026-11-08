import type { RichTextDocument, RichTextNode } from '@commerceworker/domain';
import { getSchema } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { buildExtensions } from '~/cms/components/rich-text/extensions';
import { type PmNode, toDocument, toTiptap } from '~/cms/lib/rich-text-mapper';

const doc = (content: RichTextNode[]): RichTextDocument => ({ nodeType: 'document', content });

const text = (value: string, marks: { type: string }[] = []): RichTextNode => ({
  nodeType: 'text',
  value,
  marks,
});

const paragraph = (...content: RichTextNode[]): RichTextNode => ({
  nodeType: 'paragraph',
  content,
});

const embeddedEntry = (id: string): RichTextNode => ({
  nodeType: 'embedded-entry-block',
  data: { target: { id, linkType: 'Entry' } },
  content: [],
});

const cell = (
  nodeType: 'table-header-cell' | 'table-cell',
  content: RichTextNode[],
  data: Record<string, unknown> = {},
): RichTextNode => ({ nodeType, data, content });
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
const pricing = table(
  row(
    cell('table-header-cell', [paragraph(text('Plan'))]),
    cell('table-header-cell', [paragraph(text('Price'))]),
  ),
  row(
    cell('table-cell', [paragraph(text('Starter', [{ type: 'bold' }]))]),
    cell('table-cell', [
      paragraph(text('$0')),
      {
        nodeType: 'unordered-list',
        content: [{ nodeType: 'list-item', content: [paragraph(text('forever'))] }],
      },
    ]),
  ),
);

/** Documents in the exact shape the previous block editor emitted. */
const oldEditorCorpus: RichTextDocument = doc([
  { nodeType: 'heading-1', content: [text('Title')] },
  paragraph(text('Intro paragraph')),
  { nodeType: 'heading-2', content: [text('Section')] },
  embeddedEntry('e1'),
  {
    nodeType: 'embedded-asset-block',
    data: { target: { id: 'a1', linkType: 'Asset' } },
    content: [],
  },
  paragraph(text('Outro')),
]);

describe('rich-text mapper round-trips', () => {
  it('round-trips the old-editor corpus unchanged', () => {
    expect(toDocument(toTiptap(oldEditorCorpus))).toEqual(oldEditorCorpus);
  });

  it('round-trips marks, preserving bold/italic/underline/code/strikethrough', () => {
    const value = doc([
      paragraph(
        text('plain '),
        text('bold', [{ type: 'bold' }]),
        text(' and ', []),
        text('mixed', [{ type: 'italic' }, { type: 'strikethrough' }]),
      ),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('round-trips lists, code blocks, and horizontal rules', () => {
    const value = doc([
      {
        nodeType: 'unordered-list',
        content: [
          { nodeType: 'list-item', content: [paragraph(text('One'))] },
          { nodeType: 'list-item', content: [paragraph(text('Two'))] },
        ],
      },
      {
        nodeType: 'ordered-list',
        content: [{ nodeType: 'list-item', content: [paragraph(text('First'))] }],
      },
      { nodeType: 'code-block', content: [text('const x = 1;')], data: { language: 'ts' } },
      { nodeType: 'hr', content: [] },
      paragraph(text('after')),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('converts hyperlink nodes to link marks and groups them back', () => {
    const value = doc([
      paragraph(
        text('See '),
        {
          nodeType: 'hyperlink',
          data: { uri: 'https://example.com' },
          content: [text('the docs', [{ type: 'bold' }]), text(' here')],
        },
        text(' for more.'),
      ),
    ]);
    const pm = toTiptap(value);
    const inline = pm.content?.[0]?.content ?? [];
    // Flattened: link text carries a link mark alongside its other marks.
    expect(inline.map((n) => n.text)).toEqual(['See ', 'the docs', ' here', ' for more.']);
    expect(inline[1]?.marks).toEqual([
      { type: 'bold' },
      { type: 'link', attrs: { href: 'https://example.com' } },
    ]);
    expect(toDocument(pm)).toEqual(value);
  });

  it('splits adjacent links with different targets into separate hyperlink nodes', () => {
    const pm: PmNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: 'https://a' } }] },
            { type: 'text', text: 'b', marks: [{ type: 'link', attrs: { href: 'https://b' } }] },
          ],
        },
      ],
    };
    expect(toDocument(pm)?.content[0]?.content).toEqual([
      { nodeType: 'hyperlink', data: { uri: 'https://a' }, content: [text('a')] },
      { nodeType: 'hyperlink', data: { uri: 'https://b' }, content: [text('b')] },
    ]);
  });

  it('round-trips unknown block and inline nodes byte-identically', () => {
    const callout: RichTextNode = {
      nodeType: 'callout',
      content: [{ nodeType: 'callout-title', content: [text('note')] }],
      data: { tone: 'info' },
    };
    const footnote: RichTextNode = {
      nodeType: 'footnote-ref',
      data: { note: 'n1' },
      content: [],
    };
    const value = doc([callout, paragraph(text('before '), footnote, text(' after'))]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('round-trips entry and asset hyperlinks as first-class marks', () => {
    const value = doc([
      paragraph(
        text('see '),
        {
          nodeType: 'entry-hyperlink',
          data: { target: { id: 'e9', linkType: 'Entry' } },
          content: [text('the entry', [{ type: 'bold' }])],
        },
        text(' and '),
        {
          nodeType: 'asset-hyperlink',
          data: { target: { id: 'a3', linkType: 'Asset' } },
          content: [text('the asset')],
        },
      ),
    ]);
    const pm = toTiptap(value);
    const inline = pm.content?.[0]?.content ?? [];
    expect(inline[1]?.marks).toEqual([
      { type: 'bold' },
      { type: 'entryLink', attrs: { targetId: 'e9' } },
    ]);
    expect(toDocument(pm)).toEqual(value);
  });

  it('round-trips an inline entry embed mid-sentence', () => {
    const value = doc([
      paragraph(
        text('as shown in '),
        {
          nodeType: 'embedded-entry-inline',
          data: { target: { id: 'e7', linkType: 'Entry' } },
          content: [],
        },
        text(' above'),
      ),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('keeps the innermost link when reference links nest inside a hyperlink', () => {
    const value = doc([
      paragraph({
        nodeType: 'hyperlink',
        data: { uri: 'https://outer' },
        content: [
          text('plain'),
          {
            nodeType: 'entry-hyperlink',
            data: { target: { id: 'e1', linkType: 'Entry' } },
            content: [text('inner')],
          },
        ],
      }),
    ]);
    // The outer hyperlink survives around 'plain'; 'inner' keeps its entry link.
    expect(toDocument(toTiptap(value))).toEqual(
      doc([
        paragraph(
          { nodeType: 'hyperlink', data: { uri: 'https://outer' }, content: [text('plain')] },
          {
            nodeType: 'entry-hyperlink',
            data: { target: { id: 'e1', linkType: 'Entry' } },
            content: [text('inner')],
          },
        ),
      ]),
    );
  });

  it('resolves stacked link marks by priority (entryLink over link) and strips both', () => {
    const pm: PmNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'both',
              marks: [
                { type: 'link', attrs: { href: 'https://x' } },
                { type: 'entryLink', attrs: { targetId: 'e1' } },
              ],
            },
          ],
        },
      ],
    };
    expect(toDocument(pm)?.content[0]?.content).toEqual([
      {
        nodeType: 'entry-hyperlink',
        data: { target: { id: 'e1', linkType: 'Entry' } },
        content: [text('both')],
      },
    ]);
  });

  it('carries malformed reference links (no target) through raw', () => {
    const value = doc([
      paragraph({ nodeType: 'entry-hyperlink', data: {}, content: [text('broken')] }),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('carries hyperlinks without a uri through raw (never dropped, though validation refuses them)', () => {
    const value = doc([
      paragraph(
        text('before '),
        { nodeType: 'hyperlink', data: {}, content: [text('bare')] },
        { nodeType: 'hyperlink', data: { uri: '' }, content: [text('empty')] },
      ),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('does not let a valueless inner link strip a valid outer reference link', () => {
    const value = doc([
      paragraph({
        nodeType: 'entry-hyperlink',
        data: { target: { id: 'e1', linkType: 'Entry' } },
        content: [text('a'), { nodeType: 'hyperlink', data: {}, content: [text('b')] }, text('c')],
      }),
    ]);
    const out = toDocument(toTiptap(value));
    // The outer entry link must survive around the raw inner node.
    expect(JSON.stringify(out)).toContain('entry-hyperlink');
    expect(JSON.stringify(out)).toContain('"value":"a"');
    expect(JSON.stringify(out)).toContain('"value":"b"');
  });

  it('wraps stray inline children of block containers in a paragraph', () => {
    // The previous editor emitted blockquotes with direct text children.
    const legacy = doc([{ nodeType: 'blockquote', content: [text('quoted')] }]);
    expect(toDocument(toTiptap(legacy))).toEqual(
      doc([{ nodeType: 'blockquote', content: [paragraph(text('quoted'))] }]),
    );
  });

  it('returns undefined for empty documents', () => {
    expect(toDocument({ type: 'doc', content: [{ type: 'paragraph' }] })).toBeUndefined();
    expect(toDocument({ type: 'doc', content: [] })).toBeUndefined();
    expect(toDocument(toTiptap(undefined))).toBeUndefined();
    expect(toDocument(toTiptap('not a document'))).toBeUndefined();
  });

  it('drops embeds without a target on serialize', () => {
    const pm: PmNode = {
      type: 'doc',
      content: [
        { type: 'embeddedEntryBlock', attrs: { targetId: '' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
      ],
    };
    expect(toDocument(pm)).toEqual(doc([paragraph(text('kept'))]));
  });
});

describe('rich-text mapper tables', () => {
  it('round-trips a table with header cells and block content in its cells', () => {
    const value = doc([paragraph(text('Before')), pricing, paragraph(text('After'))]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it("maps table nodes to the editor's table nodes", () => {
    expect(toTiptap(doc([table(row(cell('table-header-cell', [paragraph(text('h'))])))]))).toEqual({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'h' }] }],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('round-trips merged cells as colspan/rowspan, and drops column widths', () => {
    const value = doc([
      table(
        row(
          cell('table-cell', [paragraph(text('wide'))], { colspan: 2 }),
          cell('table-cell', [paragraph(text('tall'))], { rowspan: 2 }),
        ),
        row(cell('table-cell', [paragraph(text('a'))]), cell('table-cell', [paragraph(text('b'))])),
      ),
    ]);
    const pm = toTiptap(value);
    expect(pm.content?.[0]?.content?.[0]?.content?.[0]?.attrs).toEqual({ colspan: 2 });
    expect(toDocument(pm)).toEqual(value);
    // The editor always carries every attr; a width (or a span of 1) is not stored.
    const edited: PmNode = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, colwidth: [120] },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(toDocument(edited)).toEqual(
      doc([table(row(cell('table-cell', [paragraph(text('x'))])))]),
    );
  });

  it('keeps an empty cell as an empty paragraph, and drops rows the editor emptied', () => {
    const edited: PmNode = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [] },
            {
              type: 'tableRow',
              content: [{ type: 'tableCell', content: [{ type: 'paragraph' }] }],
            },
          ],
        },
        { type: 'table', content: [{ type: 'tableRow', content: [] }] },
      ],
    };
    expect(toDocument(edited)).toEqual(
      doc([table(row(cell('table-cell', [{ nodeType: 'paragraph', content: [] }])))]),
    );
  });

  it('carries a malformed table through raw rather than letting the editor rebuild it', () => {
    const ragged: RichTextNode = {
      nodeType: 'table',
      data: {},
      content: [row(cell('table-cell', [text('inline in a cell')])), paragraph(text('not a row'))],
    };
    const stray = row(cell('table-cell', [paragraph(text('row outside a table'))]));
    const value = doc([ragged, stray, table()]);
    const pm = toTiptap(value);
    expect(pm.content?.map((n) => n.type)).toEqual([
      'unknownBlock',
      'unknownBlock',
      'unknownBlock',
    ]);
    expect(toDocument(pm)).toEqual(value);
  });
});

describe('mapper output is schema-legal', () => {
  const schema = getSchema(buildExtensions());
  const fixtures: Record<string, unknown> = {
    'old-editor corpus': oldEditorCorpus,
    'marks and links': doc([
      paragraph(text('x', [{ type: 'bold' }, { type: 'code' }]), {
        nodeType: 'hyperlink',
        data: { uri: 'https://x' },
        content: [text('y')],
      }),
    ]),
    'lists and code': doc([
      {
        nodeType: 'unordered-list',
        content: [{ nodeType: 'list-item', content: [paragraph(text('i'))] }],
      },
      { nodeType: 'code-block', content: [text('code')] },
      { nodeType: 'hr', content: [] },
    ]),
    'unknown nodes': doc([
      { nodeType: 'callout', content: [], data: { x: 1 } },
      paragraph(text('a'), { nodeType: 'footnote-ref', data: { note: 'n1' }, content: [] }),
    ]),
    'reference links and inline embeds': doc([
      paragraph(
        {
          nodeType: 'entry-hyperlink',
          data: { target: { id: 'e1', linkType: 'Entry' } },
          content: [text('entry')],
        },
        {
          nodeType: 'asset-hyperlink',
          data: { target: { id: 'a1', linkType: 'Asset' } },
          content: [text('asset')],
        },
        {
          nodeType: 'embedded-entry-inline',
          data: { target: { id: 'e2', linkType: 'Entry' } },
          content: [],
        },
      ),
    ]),
    'nested links': doc([
      paragraph({
        nodeType: 'hyperlink',
        data: { uri: 'https://outer' },
        content: [
          {
            nodeType: 'entry-hyperlink',
            data: { target: { id: 'e1', linkType: 'Entry' } },
            content: [text('inner')],
          },
        ],
      }),
    ]),
    // API-authored shapes that need normalizing to satisfy content expressions.
    'list without list-items': doc([
      { nodeType: 'unordered-list', content: [paragraph(text('loose'))] },
      { nodeType: 'ordered-list', content: [text('bare inline')] },
    ]),
    'orphan list-item': doc([{ nodeType: 'list-item', content: [paragraph(text('stray'))] }]),
    'hyperlink with hard break': doc([
      paragraph({
        nodeType: 'hyperlink',
        data: { uri: 'https://x' },
        content: [text('a'), { nodeType: 'hard-break' }, text('b')],
      }),
    ]),
    table: doc([pricing]),
    'table nested in a cell': doc([
      table(row(cell('table-cell', [paragraph(text('outer')), pricing]))),
    ]),
    'malformed table': doc([{ nodeType: 'table', content: [text('loose')] }]),
    empty: undefined,
  };

  for (const [name, value] of Object.entries(fixtures)) {
    it(`accepts ${name}`, () => {
      // check() enforces content expressions (nodeFromJSON alone does not).
      expect(() => schema.nodeFromJSON(toTiptap(value)).check()).not.toThrow();
    });
  }
});

describe('mapper normalization of API-authored shapes', () => {
  it('wraps loose list children in list items', () => {
    const value = doc([{ nodeType: 'unordered-list', content: [paragraph(text('loose'))] }]);
    expect(toDocument(toTiptap(value))).toEqual(
      doc([
        {
          nodeType: 'unordered-list',
          content: [{ nodeType: 'list-item', content: [paragraph(text('loose'))] }],
        },
      ]),
    );
  });

  it('resolves exclusive-mark conflicts: code wins over formatting, link over code', () => {
    const value = doc([
      paragraph(text('both', [{ type: 'bold' }, { type: 'code' }]), {
        nodeType: 'hyperlink',
        data: { uri: 'https://x' },
        content: [text('linked code', [{ type: 'code' }])],
      }),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(
      doc([
        paragraph(text('both', [{ type: 'code' }]), {
          nodeType: 'hyperlink',
          data: { uri: 'https://x' },
          content: [text('linked code')],
        }),
      ]),
    );
  });

  it('keeps a hyperlink containing a hard break as one node on round trip', () => {
    const value = doc([
      paragraph({
        nodeType: 'hyperlink',
        data: { uri: 'https://x' },
        content: [text('a'), { nodeType: 'hard-break' }, text('b')],
      }),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });
});

describe('external embeds', () => {
  const embed = (data: Record<string, unknown>): RichTextNode => ({
    nodeType: 'embed',
    data,
    content: [],
  });
  const full = {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    provider: 'youtube',
    kind: 'video',
    title: 'A video',
    authorName: 'Someone',
    thumbnail: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', width: 480, height: 360 },
    width: 200,
    height: 113,
    aspectRatio: 1.7699,
  };

  it('maps an embed to an externalEmbed atom holding its data, and back unchanged', () => {
    const value = doc([embed(full)]);
    const pm = toTiptap(value);
    expect(pm.content?.[0]).toEqual({ type: 'externalEmbed', attrs: { embed: full } });
    expect(toDocument(pm)).toEqual(value);
  });

  it('round-trips an embed with only url and provider', () => {
    const value = doc([embed({ url: 'https://vimeo.com/76979871', provider: 'vimeo' })]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('carries an embed the domain would refuse through unknownBlock, verbatim', () => {
    const bad = embed({
      url: 'https://vimeo.com/76979871',
      provider: 'vimeo',
      html: '<iframe src="https://player.vimeo.com/video/76979871"></iframe>',
    });
    const pm = toTiptap(doc([bad]));
    expect(pm.content?.[0]).toEqual({ type: 'unknownBlock', attrs: { raw: bad } });
    expect(toDocument(pm)).toEqual(doc([bad]));
    const offList = embed({ url: 'https://example.com/v/1', provider: 'example' });
    expect(toTiptap(doc([offList])).content?.[0]?.type).toBe('unknownBlock');
  });

  it('writes back only the keys an embed stores, whatever the editor attrs hold', () => {
    const pm: PmNode = {
      type: 'doc',
      content: [
        {
          type: 'externalEmbed',
          attrs: {
            embed: {
              url: 'https://x.com/jack/status/20',
              provider: 'x',
              html: '<blockquote>',
              foo: 1,
            },
          },
        },
      ],
    };
    expect(toDocument(pm)).toEqual(
      doc([embed({ url: 'https://x.com/jack/status/20', provider: 'x' })]),
    );
  });

  // A list item's editor content is `paragraph block*`, so the embed follows its first paragraph.
  it('is schema-legal at the top level and inside a list item', () => {
    const schema = getSchema(buildExtensions());
    const value = doc([
      embed(full),
      {
        nodeType: 'unordered-list',
        content: [{ nodeType: 'list-item', content: [paragraph(text('i')), embed(full)] }],
      },
    ]);
    expect(() => schema.nodeFromJSON(toTiptap(value)).check()).not.toThrow();
  });
});
