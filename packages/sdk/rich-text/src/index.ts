/**
 * @commerceworker/sdk-rich-text: render CommerceWorker rich text anywhere.
 *
 *   import { toHtml } from '@commerceworker/sdk-rich-text';
 *   const html = toHtml(entry.fields.body, { entryHref: (e) => `/${e.fields?.slug}` });
 *
 * Text is always escaped and only safe link URLs are emitted, so the output can go straight into
 * a page. Zero dependencies; runs in browsers, Node, Workers, Deno and Bun.
 */
export { type HtmlOptions, toHtml } from './html.js';
export { escapeMarkdown, type MarkdownOptions, toMarkdown } from './markdown.js';
export { excerpt, toPlainText } from './plain-text.js';
export { escapeHtml, safeLinkUri } from './safe.js';
export {
  type DeliveredAsset,
  isRichTextDocument,
  type RichTextDocument,
  type RichTextMark,
  type RichTextNode,
  type RichTextTarget,
} from './types.js';
