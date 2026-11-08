import { escapeHtml, safeLinkUri } from './safe.js';
import type { DeliveredAsset, RichTextDocument, RichTextNode, RichTextTarget } from './types.js';

export interface HtmlOptions {
  /** The URL of an entry, for `entry-hyperlink` nodes. Without one, the link renders as its text. */
  readonly entryHref?: (target: RichTextTarget) => string | null | undefined;
  /** Markup for an embedded entry (`embedded-entry-block` / `-inline`). Default: nothing. */
  readonly renderEntry?: (target: RichTextTarget, info: { readonly inline: boolean }) => string;
  /** Markup for an embedded asset. Default: a responsive, lazy `<figure><img></figure>`. */
  readonly renderAsset?: (asset: DeliveredAsset) => string;
  /** `sizes` for the default image's `srcset` (default `100vw`). */
  readonly imageSizes?: string;
  /**
   * Replace how a node type renders. Return a string to use it, or `undefined` to fall back to the
   * default. `next()` renders the node's children with these same options.
   */
  readonly nodes?: Readonly<
    Record<string, (node: RichTextNode, next: () => string) => string | undefined>
  >;
  /** Replace how a mark wraps its text, e.g. `{ bold: (html) => \`<b>${html}</b>\` }`. */
  readonly marks?: Readonly<Record<string, (html: string) => string>>;
}

const MARKS: Record<string, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  code: 'code',
  strikethrough: 's',
  superscript: 'sup',
  subscript: 'sub',
};

const BLOCKS: Record<string, string> = {
  paragraph: 'p',
  'heading-1': 'h1',
  'heading-2': 'h2',
  'heading-3': 'h3',
  'heading-4': 'h4',
  'heading-5': 'h5',
  'heading-6': 'h6',
  blockquote: 'blockquote',
  'unordered-list': 'ul',
  'ordered-list': 'ol',
  'list-item': 'li',
  table: 'table',
  'table-row': 'tr',
  'table-header-cell': 'th',
  'table-cell': 'td',
};

const attr = (name: string, value: unknown) =>
  value === null || value === undefined || value === '' ? '' : ` ${name}="${escapeHtml(value)}"`;

const isAsset = (t: RichTextTarget | undefined): t is DeliveredAsset => typeof t?.url === 'string';

/** The default embedded image: sized (no layout shift), lazy, responsive when Delivery gave a srcset. */
function defaultAsset(asset: DeliveredAsset, sizes: string): string {
  const src = safeLinkUri(asset.url);
  if (!src) return '';
  const srcset = (asset.srcset ?? [])
    .map((s) => (safeLinkUri(s.url) ? `${s.url} ${s.width}w` : ''))
    .filter(Boolean)
    .join(', ');
  const caption = asset.description
    ? `<figcaption>${escapeHtml(asset.description)}</figcaption>`
    : '';
  return `<figure><img${attr('src', src)}${attr('srcset', srcset)}${srcset ? attr('sizes', sizes) : ''}${attr('width', asset.width)}${attr('height', asset.height)} alt="${escapeHtml(asset.altText ?? '')}" loading="lazy" decoding="async">${caption}</figure>`;
}

/** Renders a rich-text document to HTML. All text is escaped; only safe link URLs are emitted. */
export function toHtml(
  doc: RichTextDocument | null | undefined,
  options: HtmlOptions = {},
): string {
  if (doc?.nodeType !== 'document' || !Array.isArray(doc.content)) return '';
  const sizes = options.imageSizes ?? '100vw';

  const children = (n: RichTextNode): string => (n.content ?? []).map(render).join('');

  function text(n: RichTextNode): string {
    let out = escapeHtml(n.value ?? '');
    for (const mark of n.marks ?? []) {
      const custom = options.marks?.[mark.type];
      const tag = MARKS[mark.type];
      if (custom) out = custom(out);
      else if (tag) out = `<${tag}>${out}</${tag}>`;
    }
    return out;
  }

  function link(href: string | null | undefined, n: RichTextNode): string {
    return href ? `<a${attr('href', href)}>${children(n)}</a>` : children(n);
  }

  function byDefault(n: RichTextNode): string {
    const target = n.data?.target;
    switch (n.nodeType) {
      case 'text':
        return text(n);
      case 'hard-break':
        return '<br>';
      case 'hr':
        return '<hr>';
      case 'code-block':
        return `<pre><code>${escapeHtml((n.content ?? []).map((c) => c.value ?? '').join(''))}</code></pre>`;
      case 'hyperlink':
        return link(safeLinkUri(n.data?.uri), n);
      case 'entry-hyperlink':
        return link(target ? safeLinkUri(options.entryHref?.(target) ?? undefined) : undefined, n);
      case 'asset-hyperlink':
        return link(isAsset(target) ? safeLinkUri(target.url) : undefined, n);
      case 'embedded-entry-block':
      case 'embedded-entry-inline':
        return target && options.renderEntry
          ? options.renderEntry(target, { inline: n.nodeType === 'embedded-entry-inline' })
          : '';
      case 'embedded-asset-block':
        if (!isAsset(target)) return '';
        return options.renderAsset ? options.renderAsset(target) : defaultAsset(target, sizes);
      case 'embed': {
        // A third-party embed (video, post): a plain link by default; render an iframe yourself.
        const url = safeLinkUri(n.data?.url);
        const title = typeof n.data?.title === 'string' ? n.data.title : url;
        return url ? `<p><a${attr('href', url)}>${escapeHtml(title)}</a></p>` : '';
      }
      default: {
        const tag = BLOCKS[n.nodeType];
        return tag ? `<${tag}>${children(n)}</${tag}>` : children(n);
      }
    }
  }

  function render(n: RichTextNode): string {
    if (!n || typeof n !== 'object' || typeof n.nodeType !== 'string') return '';
    const custom = options.nodes?.[n.nodeType];
    if (custom) {
      const out = custom(n, () => children(n));
      if (out !== undefined) return out;
    }
    return byDefault(n);
  }

  return doc.content.map(render).join('');
}
