/**
 * A small builder for `RichTextDocument` trees, so the brand's long-form content reads as authored
 * prose with real structure (chapters, lists, tables, quotes, embeds, links) rather than one
 * paragraph of text. Content is structured, never markup: these are the document's own nodes.
 */

export type Node = Record<string, unknown>;
type Inline = string | Node;
const MARK = (type: string) => ({ type });

export const t = (value: string, ...marks: string[]): Node => ({
  nodeType: 'text',
  value,
  marks: marks.map(MARK),
});
export const b = (value: string) => t(value, 'bold');
export const i = (value: string) => t(value, 'italic');

const inline = (parts: readonly Inline[]): Node[] =>
  parts.map((p) => (typeof p === 'string' ? t(p) : p));

export const p = (...parts: Inline[]): Node => ({ nodeType: 'paragraph', content: inline(parts) });
export const h2 = (value: string): Node => ({ nodeType: 'heading-2', content: [t(value)] });
export const h3 = (value: string): Node => ({ nodeType: 'heading-3', content: [t(value)] });
export const ul = (items: readonly Inline[]): Node => ({
  nodeType: 'unordered-list',
  content: items.map((it) => ({ nodeType: 'list-item', content: [p(it)] })),
});
export const ol = (items: readonly Inline[]): Node => ({
  nodeType: 'ordered-list',
  content: items.map((it) => ({ nodeType: 'list-item', content: [p(it)] })),
});
export const quote = (value: string): Node => ({ nodeType: 'blockquote', content: [p(value)] });
export const hr = (): Node => ({ nodeType: 'hr', content: [] });
export const a = (uri: string, label: string): Node => ({
  nodeType: 'hyperlink',
  data: { uri },
  content: [t(label)],
});
export const entryLinkInline = (id: string, label: string): Node => ({
  nodeType: 'entry-hyperlink',
  data: { target: { id, linkType: 'Entry' } },
  content: [t(label)],
});
export const embedEntry = (id: string): Node => ({
  nodeType: 'embedded-entry-block',
  data: { target: { id, linkType: 'Entry' } },
});
export const embedAsset = (id: string): Node => ({
  nodeType: 'embedded-asset-block',
  data: { target: { id, linkType: 'Asset' } },
});
export const table = (rows: readonly (readonly string[])[]): Node => ({
  nodeType: 'table',
  data: {},
  content: rows.map((cells, r) => ({
    nodeType: 'table-row',
    data: {},
    content: cells.map((value) => ({
      nodeType: r === 0 ? 'table-header-cell' : 'table-cell',
      data: {},
      content: [p(value)],
    })),
  })),
});

export const doc = (...content: (Node | false | undefined)[]): Node => ({
  nodeType: 'document',
  content: content.filter((n): n is Node => Boolean(n)),
});

/** Paragraphs from plain strings: the translated bodies, which are prose without structure. */
export const paras = (...texts: string[]): Node => doc(...texts.map((x) => p(x)));
