/**
 * HTML → structured rich text, for content arriving from systems that store
 * HTML (a WordPress export, a CSV of blog posts).
 *
 * Lenient on purpose. Stored HTML is rarely well-formed — unclosed `<p>` and
 * `<li>`, stray end tags, WordPress's convention of separating paragraphs with
 * blank lines rather than tags — and an import that rejects a post over a
 * missing `</p>` helps nobody. So the reader recovers the way a browser does,
 * and the converter keeps text it does not understand rather than dropping it:
 * an unknown element contributes its text, never nothing.
 *
 * What does not map is converted to something visible rather than lost.
 * Images and unknown media become links to their source, because there is no
 * asset to point a node at yet, and a link is something an editor can see and
 * fix. Media from an allowed embed provider (a YouTube iframe, a tweet's
 * blockquote, a WordPress embed block, a bare URL on its own line) becomes an
 * `embed` node holding only its URL and provider: the player markup is
 * discarded, and metadata is the import's or the editor's to resolve later.
 *
 * Pure and DOM-free: the domain runs on Node and in a Worker alike.
 */

import { MAX_EMBED_URL_LENGTH, matchEmbedProvider, parseAbsoluteUrl } from './embed';
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  type RichTextDocument,
  type RichTextMark,
  type RichTextNode,
  safeLinkUri,
} from './rich-text';

interface HtmlElement {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: HtmlNode[];
}
type HtmlNode = HtmlElement | string;

/** Elements with no content and no end tag. */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/** Elements whose content is never shown, and is not markup. */
const RAW_TEXT_DROPPED = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'title']);

/** Elements dropped with everything inside them. */
const DROPPED = new Set([
  ...RAW_TEXT_DROPPED,
  'head',
  'svg',
  'math',
  'form',
  'select',
  'button',
  'object',
]);

/** Block-level elements that become a node of their own. */
const HEADINGS: Record<string, string> = {
  h1: 'heading-1',
  h2: 'heading-2',
  h3: 'heading-3',
  h4: 'heading-4',
  h5: 'heading-5',
  h6: 'heading-6',
};

/** Block-level elements that only group other blocks; their children are kept, they are not. */
const TRANSPARENT_BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'body',
  'caption',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'header',
  'html',
  'main',
  'nav',
  'section',
  'summary',
]);

/** A table's parts; `table` itself converts (see `table`), and these only ever appear inside it. */
const TABLE_PARTS = new Set(['tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);

const BLOCK = new Set([
  ...TRANSPARENT_BLOCKS,
  ...TABLE_PARTS,
  ...Object.keys(HEADINGS),
  'blockquote',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'table',
  'ul',
]);

const MARKS: Record<string, string> = {
  b: 'bold',
  strong: 'bold',
  em: 'italic',
  i: 'italic',
  u: 'underline',
  code: 'code',
  kbd: 'code',
  samp: 'code',
  s: 'strikethrough',
  del: 'strikethrough',
  strike: 'strikethrough',
};

/** Elements whose source is media, kept as a link so the reference survives. */
const MEDIA = new Set(['img', 'iframe', 'video', 'audio', 'embed', 'picture']);

/**
 * Nesting beyond this is read as flat text. Real content never gets close;
 * a hostile file that opens a hundred thousand `<div>`s should not cost a
 * stack overflow.
 */
const MAX_DEPTH = 128;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  divide: '÷',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  shy: '­',
  iexcl: '¡',
  iquest: '¿',
};

/** Converts an HTML fragment (or a whole document) into a rich-text document. */
export function richTextFromHtml(html: string): RichTextDocument {
  return { nodeType: 'document', data: {}, content: blocks(parseHtml(html).children, true) };
}

// --- reading ---------------------------------------------------------------

function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { tag: '#root', attributes: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const top = () => stack[stack.length - 1] as HtmlElement;
  // Adjacent text is one run, so "a < b" stays one text node rather than three.
  const pushText = (text: string) => {
    const { children } = top();
    const last = children[children.length - 1];
    if (typeof last === 'string') children[children.length - 1] = last + text;
    else children.push(text);
  };
  let i = 0;

  const closeTo = (tag: string, stopAt: readonly string[] = []) => {
    for (let j = stack.length - 1; j > 0; j -= 1) {
      const name = (stack[j] as HtmlElement).tag;
      if (stopAt.includes(name)) return;
      if (name === tag) {
        stack.length = j;
        return;
      }
    }
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(decodeHtmlEntities(html.slice(i)));
      break;
    }
    if (lt > i) pushText(decodeHtmlEntities(html.slice(i, lt)));
    i = lt;

    if (html.startsWith('<!--', i)) {
      // Comments include WordPress's block delimiters (`<!-- wp:paragraph -->`),
      // which are editor bookkeeping and nothing a reader sees.
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    const tag = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(i, i + 64));
    if (!tag) {
      // A `<` that starts no tag is text: "a < b" is a sentence, not markup.
      pushText('<');
      i += 1;
      continue;
    }
    const [, slash, rawName] = tag;
    const name = (rawName as string).toLowerCase();
    const { attributes, end } = readAttributes(html, i + tag[0].length);
    i = end;

    if (slash) {
      if (name === 'p' && !stack.some((e) => e.tag === 'p')) {
        // A stray `</p>` is an empty paragraph in a browser; here it is nothing.
        continue;
      }
      closeTo(name);
      continue;
    }

    if (RAW_TEXT_DROPPED.has(name)) {
      // Searched case-insensitively in place: lowercasing a copy can change its
      // length (some characters lowercase to two), and the indices would drift.
      const closing = new RegExp(`</${name}`, 'gi');
      closing.lastIndex = i;
      const close = closing.exec(html)?.index ?? -1;
      i = close === -1 ? html.length : html.indexOf('>', close) + 1 || html.length;
      continue;
    }

    // The implied end tags that matter in practice: a block closes an open
    // paragraph, a list item closes the previous one, and a table's parts close
    // their open siblings — never past the nearest `table`, so a table nested in
    // a cell keeps the outer cell open.
    if (BLOCK.has(name) && top().tag === 'p') stack.pop();
    if (name === 'li') closeTo('li', ['ul', 'ol']);
    if (name === 'td' || name === 'th') {
      closeTo('td', ['tr', 'table']);
      closeTo('th', ['tr', 'table']);
    }
    if (name === 'tr') closeTo('tr', ['table']);
    if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
      for (const section of ['thead', 'tbody', 'tfoot']) closeTo(section, ['table']);
    }

    const element: HtmlElement = { tag: name, attributes, children: [] };
    top().children.push(element);
    // `/>` is ignored on anything but a void element, as a browser ignores it —
    // which is also why `<a href=/about/>` opens a link rather than closing one.
    if (!VOID.has(name) && stack.length < MAX_DEPTH) stack.push(element);
  }
  return root;
}

function readAttributes(
  html: string,
  start: number,
): { attributes: Record<string, string>; end: number } {
  const attributes: Record<string, string> = {};
  const pattern = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?|\s*\/?\s*>/y;
  let i = start;
  for (;;) {
    pattern.lastIndex = i;
    const match = pattern.exec(html);
    if (!match) {
      // An unterminated tag runs to the end of the input, as a browser reads it.
      const close = html.indexOf('>', i);
      return { attributes, end: close === -1 ? html.length : close + 1 };
    }
    i = pattern.lastIndex;
    if (match[1] === undefined) return { attributes, end: i };
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(value);
  }
}

function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    // An entity this table does not know is left as written, which is how a
    // browser shows it too — visible, and fixable by an editor.
    return ENTITIES[body] ?? match;
  });
}

// --- converting --------------------------------------------------------------

/**
 * Converts a run of HTML nodes into blocks.
 *
 * Inline content between blocks is gathered into paragraphs. Where the HTML
 * has no paragraph tags at all — WordPress's classic editor stores paragraphs
 * as blank-line-separated text — a blank line starts a new paragraph and a
 * single newline is a line break, which is what WordPress itself renders.
 * That reading (`autop`) applies at the top level and in a blockquote, where
 * such text lives; inside other elements a newline is just whitespace.
 */
function blocks(nodes: readonly HtmlNode[], autop: boolean): RichTextNode[] {
  const out: RichTextNode[] = [];
  let pending: RichTextNode[] = [];

  const flush = () => {
    const paragraph = paragraphOf(pending);
    if (paragraph) out.push(paragraph);
    pending = [];
  };

  nodes.forEach((node, at) => {
    if (typeof node === 'string') {
      if (!autop) {
        pending.push(textNode(node, []));
        return;
      }
      const parts = node.split(/\n[ \t\r\f]*\n/);
      parts.forEach((part, index) => {
        if (index > 0) flush();
        // WordPress embeds a provider URL that stands on its own, as its own
        // paragraph: nothing before it in this paragraph, nothing after it.
        const alone =
          (index > 0 || !paragraphOf(pending)) &&
          (index < parts.length - 1 || standsAlone(nodes[at + 1]));
        const standalone = alone ? embedFromUrlLine(part) : undefined;
        if (standalone) {
          flush();
          out.push(standalone);
          return;
        }
        part.split('\n').forEach((line, n) => {
          if (n > 0) pending.push({ nodeType: 'hard-break', data: {}, content: [] });
          pending.push(textNode(line, []));
        });
      });
      return;
    }
    if (DROPPED.has(node.tag)) return;
    if (!BLOCK.has(node.tag)) {
      const embed = embedOf(node);
      if (embed) {
        flush();
        out.push(embed);
      } else {
        pending.push(...inline(node, []));
      }
      return;
    }
    flush();
    out.push(...block(node));
  });
  flush();
  return out;
}

/** Whether what follows a line of text leaves it standing alone: nothing, or a block. */
function standsAlone(next: HtmlNode | undefined): boolean {
  return next === undefined || (typeof next !== 'string' && BLOCK.has(next.tag));
}

function block(element: HtmlElement): RichTextNode[] {
  const { tag } = element;
  const embed = embedOf(element);
  if (embed) {
    // A WordPress embed figure's caption is prose, and stays as prose after it.
    const caption = element.children.filter(
      (c): c is HtmlElement => typeof c !== 'string' && c.tag === 'figcaption',
    );
    return [embed, ...caption.flatMap((c) => blocks(c.children, false))];
  }
  const heading = HEADINGS[tag];
  if (heading) return withInline(heading, element);
  switch (tag) {
    case 'p':
      return withInline('paragraph', element);
    case 'hr':
      return [{ nodeType: 'hr', data: {}, content: [] }];
    case 'pre': {
      const value = textContent(element).replace(/^\n/, '').replace(/\s+$/, '');
      return value
        ? [{ nodeType: 'code-block', data: {}, content: [textNode(value, [], true)] }]
        : [];
    }
    case 'blockquote': {
      const content = blocks(element.children, true);
      return content.length ? [{ nodeType: 'blockquote', data: {}, content }] : [];
    }
    case 'ul':
    case 'ol': {
      const items: RichTextNode[] = [];
      let stray: HtmlNode[] = [];
      const flushStray = () => {
        const content = blocks(stray, false);
        if (content.length) items.push({ nodeType: 'list-item', data: {}, content });
        stray = [];
      };
      for (const node of element.children) {
        if (typeof node !== 'string' && node.tag === 'li') {
          flushStray();
          items.push({ nodeType: 'list-item', data: {}, content: nonEmptyBlocks(node) });
        } else {
          stray.push(node);
        }
      }
      flushStray();
      if (!items.length) return [];
      return [
        { nodeType: tag === 'ul' ? 'unordered-list' : 'ordered-list', data: {}, content: items },
      ];
    }
    case 'table':
      return table(element);
    case 'li':
      // A list item outside a list reads as what it holds.
      return blocks(element.children, false);
    default:
      return blocks(element.children, false);
  }
}

/**
 * A list item or table cell always holds at least one block, so it is never an
 * empty bullet or a cell the editor cannot put a cursor in.
 */
function nonEmptyBlocks(element: HtmlElement): RichTextNode[] {
  const content = blocks(element.children, false);
  return content.length
    ? content
    : [{ nodeType: 'paragraph', data: {}, content: [textNode('', [])] }];
}

/**
 * A `<table>` becomes a `table` of `table-row`s of cells (`th` a header cell),
 * whether its rows sit in `thead`/`tbody`/`tfoot` or directly in the table.
 *
 * What a table holds outside its cells — a `<caption>`, or text a careless
 * export left between rows — is kept as blocks before it, which is where a
 * browser shows it too. A table past the domain's bounds, or with no cells at
 * all, reads as what it holds instead: its text survives, its grid does not.
 */
function table(element: HtmlElement): RichTextNode[] {
  const rows: RichTextNode[] = [];
  const outside: HtmlNode[] = [];
  let tooLarge = false;
  const readRow = (tr: HtmlElement) => {
    const cells: RichTextNode[] = [];
    for (const node of tr.children) {
      if (typeof node !== 'string' && (node.tag === 'td' || node.tag === 'th')) {
        cells.push({
          nodeType: node.tag === 'th' ? 'table-header-cell' : 'table-cell',
          data: spans(node),
          content: nonEmptyBlocks(node),
        });
      } else {
        outside.push(node);
      }
    }
    if (cells.length > MAX_TABLE_COLUMNS) tooLarge = true;
    if (cells.length) rows.push({ nodeType: 'table-row', data: {}, content: cells });
  };
  for (const node of element.children) {
    if (typeof node === 'string') outside.push(node);
    else if (node.tag === 'tr') readRow(node);
    else if (node.tag === 'thead' || node.tag === 'tbody' || node.tag === 'tfoot') {
      for (const child of node.children) {
        if (typeof child !== 'string' && child.tag === 'tr') readRow(child);
        else outside.push(child);
      }
    } else if (node.tag !== 'colgroup') outside.push(node);
  }
  if (!rows.length || tooLarge || rows.length > MAX_TABLE_ROWS) {
    return blocks(element.children, false);
  }
  return [...blocks(outside, false), { nodeType: 'table', data: {}, content: rows }];
}

/** A cell's `colspan`/`rowspan`, kept only when it actually spans and stays in bounds. */
function spans(cell: HtmlElement): Record<string, number> {
  const data: Record<string, number> = {};
  for (const [name, max] of [
    ['colspan', MAX_TABLE_COLUMNS],
    ['rowspan', MAX_TABLE_ROWS],
  ] as const) {
    const value = Number(cell.attributes[name]);
    if (Number.isInteger(value) && value > 1) data[name] = Math.min(value, max);
  }
  return data;
}

/**
 * A block of inline content. An embeddable player inside it (`<p><iframe>`, as
 * editors commonly store one) is lifted out as an `embed` block of its own,
 * splitting the text around it, because an embed is a block and cannot sit in
 * a line of text.
 */
function withInline(nodeType: string, element: HtmlElement): RichTextNode[] {
  const out: RichTextNode[] = [];
  let run: RichTextNode[] = [];
  const flush = () => {
    const content = tidy(run);
    if (content.length) out.push({ nodeType, data: {}, content });
    run = [];
  };
  for (const child of element.children) {
    const embed = typeof child === 'string' ? undefined : embedOf(child);
    if (embed) {
      flush();
      out.push(embed);
    } else {
      run.push(...inline(child, []));
    }
  }
  flush();
  return out;
}

// --- embeds ------------------------------------------------------------------

/** Blockquote classes the providers' embed snippets use for a post. */
const POST_BLOCKQUOTE_CLASSES = ['twitter-tweet', 'bluesky-embed', 'mastodon-embed'];

/**
 * An `embed` node for an element, when it is media from an allowed provider:
 * a player `<iframe>`, a provider's post `<blockquote>`, or a WordPress
 * `wp-block-embed` figure. Everything else, unknown providers included, is
 * left to the usual reading (an unknown player stays a link to its source).
 */
function embedOf(element: HtmlElement): RichTextNode | undefined {
  const classes = (element.attributes.class ?? '').split(/\s+/);
  if (element.tag === 'iframe') return embedNode(pageUrlOfPlayer(element.attributes.src));
  if (element.tag === 'blockquote' && classes.some((c) => POST_BLOCKQUOTE_CLASSES.includes(c))) {
    const bluesky = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(
      element.attributes['data-bluesky-uri'] ?? '',
    );
    const candidates = [
      ...(bluesky ? [`https://bsky.app/profile/${bluesky[1]}/post/${bluesky[2]}`] : []),
      pageUrlOfPlayer(element.attributes['data-embed-url']),
      // A tweet's status link comes last, after any links in the post's text.
      ...hrefsIn(element).reverse(),
    ];
    for (const candidate of candidates) {
      const embed = embedNode(candidate);
      if (embed && matchEmbedProvider(String(embed.data?.url))?.provider.kind === 'post') {
        return embed;
      }
    }
    return undefined;
  }
  if (element.tag === 'figure' && classes.includes('wp-block-embed')) {
    // The block's markup holds the URL as the wrapper's text; a rendered page
    // may have swapped in the provider's player or a link instead.
    const wrapper = element.children.find(
      (c): c is HtmlElement =>
        typeof c !== 'string' && (c.attributes.class ?? '').includes('wp-block-embed__wrapper'),
    );
    const iframe = findElement(element, 'iframe');
    return (
      embedNode(wrapper ? textContent(wrapper).trim() : undefined) ??
      embedNode(pageUrlOfPlayer(iframe?.attributes.src)) ??
      hrefsIn(element)
        .map(embedNode)
        .find((e) => e !== undefined)
    );
  }
  return undefined;
}

/** A `[embed]URL[/embed]` shortcode or a bare URL, alone on its line, as an embed. */
function embedFromUrlLine(line: string): RichTextNode | undefined {
  // Trimmed and length-gated first: the pattern's whitespace runs, unanchored by a
  // trim, backtrack quadratically over a long run of spaces in hostile input.
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_EMBED_URL_LENGTH + 64) return undefined;
  const url =
    /^(?:\[embed[^\]]{0,64}\])?\s{0,8}(https?:\/\/[^\s<>"[\]]+)\s{0,8}(?:\[\/embed\])?$/i.exec(
      trimmed,
    )?.[1];
  return embedNode(url);
}

/**
 * The embed node for a URL on an allowed provider, holding only what the URL
 * says (url, provider, kind). An old post's `http://` or protocol-relative
 * `//` link to a provider is read as the https page it now is.
 */
function embedNode(raw: string | undefined): RichTextNode | undefined {
  if (!raw) return undefined;
  const upgraded = raw.trim().replace(/^(?:http:)?\/\//i, 'https://');
  const match = matchEmbedProvider(upgraded);
  if (!match) return undefined;
  return {
    nodeType: 'embed',
    data: { url: match.url.href, provider: match.provider.id, kind: match.provider.kind },
    content: [],
  };
}

/**
 * The page a provider's player URL shows, where the two differ: an embed
 * stores the page (what a reader would share), not the player.
 */
function pageUrlOfPlayer(src: string | undefined): string | undefined {
  if (!src) return undefined;
  const raw = src.trim().replace(/^(?:http:)?\/\//i, 'https://');
  const url = parseAbsoluteUrl(raw);
  if (!url) return undefined;
  const host = url.hostname;
  const path = url.pathname;
  const youtube = /^\/embed\/([\w-]{11})/.exec(path);
  if (youtube && /^(?:www\.)?youtube(?:-nocookie)?\.com$/.test(host)) {
    return `https://www.youtube.com/watch?v=${youtube[1]}`;
  }
  const vimeo = /^\/video\/(\d+)/.exec(path);
  if (vimeo && host === 'player.vimeo.com') return `https://vimeo.com/${vimeo[1]}`;
  if (host === 'open.spotify.com') return `https://open.spotify.com${path.replace(/^\/embed/, '')}`;
  if (host === 'w.soundcloud.com') return url.searchParams.get('url') ?? undefined;
  const bluesky = /^\/embed\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)/.exec(path);
  if (bluesky && host === 'embed.bsky.app') {
    return `https://bsky.app/profile/${bluesky[1]}/post/${bluesky[2]}`;
  }
  // A Mastodon post's player is the post's own URL with `/embed` after it.
  if (/^\/@[^/]+\/\d+\/embed$/.test(path)) return `https://${host}${path.slice(0, -6)}`;
  return raw;
}

function hrefsIn(node: HtmlNode): string[] {
  if (typeof node === 'string') return [];
  const own = node.tag === 'a' && node.attributes.href ? [node.attributes.href] : [];
  return [...own, ...node.children.flatMap(hrefsIn)];
}

function findElement(node: HtmlNode, tag: string): HtmlElement | undefined {
  if (typeof node === 'string') return undefined;
  if (node.tag === tag) return node;
  for (const child of node.children) {
    const found = findElement(child, tag);
    if (found) return found;
  }
  return undefined;
}

/**
 * Converts inline content. `inLink` is set inside a link: a link cannot hold
 * another (no renderer or editor can show one), so a nested link or a linked
 * image contributes its text to the outer link instead — the common WordPress
 * `<a href="full.jpg"><img src="thumb.jpg"></a>` is one link, to the full image.
 */
function inline(node: HtmlNode, marks: readonly RichTextMark[], inLink = false): RichTextNode[] {
  if (typeof node === 'string') return [textNode(node, marks)];
  const { tag } = node;
  if (DROPPED.has(tag)) return [];
  if (tag === 'br') return [{ nodeType: 'hard-break', data: {}, content: [] }];

  const children = (extra?: RichTextMark, linked = inLink) =>
    node.children.flatMap((c) =>
      inline(
        c,
        extra && !marks.some((m) => m.type === extra.type) ? [...marks, extra] : marks,
        linked,
      ),
    );

  if (MEDIA.has(tag)) {
    // `<video><source src>` carries its source on a child, not the element.
    const source = node.children.find(
      (c): c is HtmlElement => typeof c !== 'string' && c.tag === 'source' && !!c.attributes.src,
    );
    const src = safeLinkUri(node.attributes.src ?? source?.attributes.src);
    const label = node.attributes.alt || node.attributes.title || src;
    // Inside a link, or with no source worth linking to, the image is its alt text.
    if (inLink || !src) return label ? [textNode(label, marks)] : children();
    return [hyperlink(src, [textNode(label || src, marks)])];
  }

  if (tag === 'a') {
    // Imported HTML is someone else's: an unsafe link keeps its text and loses
    // its target, rather than failing validation for the whole post.
    const href = safeLinkUri(node.attributes.href);
    if (!href || inLink) return children();
    const content = children(undefined, true);
    // A link with no text is nothing a reader can click; its breaks, if any, stay.
    const hasText = content.some((n) => n.nodeType === 'text' && n.value?.trim());
    return hasText ? [hyperlink(href, content)] : content;
  }
  const mark = MARKS[tag];
  return mark ? children({ type: mark }) : children();
}

function hyperlink(uri: string, content: RichTextNode[]): RichTextNode {
  return { nodeType: 'hyperlink', data: { uri }, content };
}

function textNode(
  value: string,
  marks: readonly RichTextMark[],
  preformatted = false,
): RichTextNode {
  return {
    nodeType: 'text',
    value: preformatted ? value : value.replace(/[ \t\n\r\f]+/g, ' '),
    marks: [...marks],
    data: {},
  };
}

function textContent(node: HtmlNode): string {
  if (typeof node === 'string') return node;
  if (node.tag === 'br') return '\n';
  return node.children.map(textContent).join('');
}

/** A paragraph of gathered inline content, or nothing when it holds no text. */
function paragraphOf(content: RichTextNode[]): RichTextNode | undefined {
  const tidied = tidy(content);
  return tidied.length ? { nodeType: 'paragraph', data: {}, content: tidied } : undefined;
}

/**
 * Trims a run of inline nodes: leading and trailing whitespace and breaks go,
 * empty text nodes go, and a run with no visible text is no run at all.
 */
function tidy(content: RichTextNode[]): RichTextNode[] {
  const nodes = content.filter((n) => n.nodeType !== 'text' || n.value !== '');
  const isBlank = (n: RichTextNode) =>
    n.nodeType === 'hard-break' || (n.nodeType === 'text' && !n.value?.trim());
  while (nodes.length && isBlank(nodes[0] as RichTextNode)) nodes.shift();
  while (nodes.length && isBlank(nodes[nodes.length - 1] as RichTextNode)) nodes.pop();
  if (!nodes.length) return [];

  const first = nodes[0] as RichTextNode;
  if (first.nodeType === 'text') nodes[0] = { ...first, value: first.value?.trimStart() };
  const lastIndex = nodes.length - 1;
  const last = nodes[lastIndex] as RichTextNode;
  if (last.nodeType === 'text') nodes[lastIndex] = { ...last, value: last.value?.trimEnd() };
  return nodes;
}
