import type { RichTextDocument, RichTextNode } from './types.js';

const BLOCK_SEPARATED = new Set(['document', 'list-item', 'table-row', 'blockquote']);

/** The text of a document: blocks on their own lines, no markup. For excerpts, search and meta. */
export function toPlainText(doc: RichTextDocument | RichTextNode | null | undefined): string {
  const walk = (n: RichTextNode | RichTextDocument): string => {
    if (n.nodeType === 'text') return (n as RichTextNode).value ?? '';
    if (n.nodeType === 'hard-break') return '\n';
    const parts = (n.content ?? []).map(walk);
    const isBlockList =
      n.nodeType === 'document' || BLOCK_SEPARATED.has(n.nodeType) || /list$/.test(n.nodeType);
    return parts.join(isBlockList ? '\n' : n.nodeType === 'table-row' ? '\t' : '');
  };
  return doc
    ? walk(doc)
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : '';
}

/** The first non-empty paragraph's text, trimmed to `max` characters on a word boundary. */
export function excerpt(doc: RichTextDocument | null | undefined, max = 160): string {
  const p = (doc?.content ?? []).find((n) => n.nodeType === 'paragraph' && toPlainText(n).trim());
  const t = p ? toPlainText(p).replace(/\s+/g, ' ').trim() : '';
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t;
}
