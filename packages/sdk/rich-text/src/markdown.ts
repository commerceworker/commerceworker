import { safeLinkUri } from './safe.js';
import type { RichTextDocument, RichTextNode, RichTextTarget } from './types.js';

export interface MarkdownOptions {
  /** The URL of an entry, for `entry-hyperlink` nodes. Without one, the link renders as its text. */
  readonly entryHref?: (target: RichTextTarget) => string | null | undefined;
  /** Markdown for an embedded entry. Default: nothing. */
  readonly renderEntry?: (target: RichTextTarget, info: { readonly inline: boolean }) => string;
}

/** Escapes Markdown syntax in text, so content can't turn into links, emphasis or headings. */
export const escapeMarkdown = (s: unknown): string =>
  String(s ?? '').replace(/([\\`*_[\]<>#|])/g, '\\$1');

const url = (u: string) => u.replace(/\)/g, '%29').replace(/ /g, '%20');

/** Renders a rich-text document to CommonMark (with GFM tables and strikethrough). */
export function toMarkdown(
  doc: RichTextDocument | null | undefined,
  options: MarkdownOptions = {},
): string {
  if (doc?.nodeType !== 'document' || !Array.isArray(doc.content)) return '';

  function inline(nodes: readonly RichTextNode[] | undefined): string {
    return (nodes ?? [])
      .map((n) => {
        const target = n.data?.target;
        switch (n.nodeType) {
          case 'text': {
            const marks = new Set((n.marks ?? []).map((m) => m.type));
            if (marks.has('code')) return `\`${String(n.value ?? '').replace(/`/g, '')}\``;
            let t = escapeMarkdown(n.value);
            if (!t.trim()) return t;
            if (marks.has('bold')) t = `**${t}**`;
            if (marks.has('italic')) t = `*${t}*`;
            if (marks.has('strikethrough')) t = `~~${t}~~`;
            return t;
          }
          case 'hard-break':
            return '  \n';
          case 'hyperlink':
          case 'entry-hyperlink':
          case 'asset-hyperlink': {
            let href: string | undefined;
            if (n.nodeType === 'hyperlink') href = safeLinkUri(n.data?.uri);
            else if (n.nodeType === 'asset-hyperlink') href = safeLinkUri(target?.url);
            else href = target ? safeLinkUri(options.entryHref?.(target) ?? undefined) : undefined;
            const label = inline(n.content);
            return href ? `[${label}](${url(href)})` : label;
          }
          case 'embedded-entry-inline':
            return target && options.renderEntry
              ? options.renderEntry(target, { inline: true })
              : '';
          default:
            return inline(n.content);
        }
      })
      .join('');
  }

  function block(n: RichTextNode, depth = 0): string {
    const pad = '  '.repeat(depth);
    const target = n.data?.target;
    switch (n.nodeType) {
      case 'paragraph':
        return inline(n.content);
      case 'heading-1':
      case 'heading-2':
      case 'heading-3':
      case 'heading-4':
      case 'heading-5':
      case 'heading-6':
        return `${'#'.repeat(Number(n.nodeType.slice(-1)))} ${inline(n.content)}`;
      case 'blockquote':
        return blocks(n.content)
          .split('\n')
          .map((l) => `> ${l}`.trimEnd())
          .join('\n');
      case 'code-block': {
        const code = (n.content ?? []).map((c) => c.value ?? '').join('');
        const fence = code.includes('```') ? '````' : '```';
        return `${fence}\n${code}\n${fence}`;
      }
      case 'hr':
        return '---';
      case 'unordered-list':
      case 'ordered-list':
        return (n.content ?? [])
          .map((item, i) => {
            const bullet = n.nodeType === 'ordered-list' ? `${i + 1}.` : '-';
            const [first, ...rest] = item.content ?? [];
            const head = first ? block(first, depth + 1) : '';
            const tail = rest
              .map((c) => block(c, depth + 1))
              .filter(Boolean)
              .map((t) => `\n${pad}  ${t}`)
              .join('');
            return `${pad}${bullet} ${head}${tail}`;
          })
          .join('\n');
      case 'table': {
        const rows = (n.content ?? []).map((r) =>
          (r.content ?? []).map((c) => blocks(c.content).replace(/\n+/g, ' ')),
        );
        if (!rows.length) return '';
        const width = Math.max(...rows.map((r) => r.length));
        const line = (r: string[]) =>
          `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
        return [
          line(rows[0] ?? []),
          line(Array(width).fill('---')),
          ...rows.slice(1).map(line),
        ].join('\n');
      }
      case 'embedded-asset-block': {
        const src = safeLinkUri(target?.url);
        const alt = typeof target?.altText === 'string' ? target.altText : '';
        return src ? `![${escapeMarkdown(alt)}](${url(src)})` : '';
      }
      case 'embedded-entry-block':
        return target && options.renderEntry ? options.renderEntry(target, { inline: false }) : '';
      case 'embed': {
        const href = safeLinkUri(n.data?.url);
        const title = typeof n.data?.title === 'string' ? n.data.title : href;
        return href ? `[${escapeMarkdown(title)}](${url(href)})` : '';
      }
      default:
        return blocks(n.content);
    }
  }

  function blocks(nodes: readonly RichTextNode[] | undefined): string {
    return (nodes ?? [])
      .map((n) => block(n))
      .filter((s) => s !== '')
      .join('\n\n');
  }

  return blocks(doc.content);
}
