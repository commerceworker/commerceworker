import {
  type LinkType,
  type RichTextDocument,
  type RichTextMark,
  type RichTextNode,
  safeLinkUri,
  validateRichText,
} from '@commerceworker/domain';
import { isObject, type Json, str } from './model';

/**
 * The export's rich text is a typed node tree of the same family as `RichTextDocument`: the same
 * `nodeType` names, `content`, `marks` and `data`. Conversion is therefore a walk that copies
 * nodes, rewrites every link target (`data.target.sys`) to the id the target takes here, and
 * deals with the few things that differ. Nothing goes through HTML.
 */

/** Node types this platform stores exactly as the export spells them. */
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5',
  'heading-6',
  'blockquote',
  'hr',
  'unordered-list',
  'ordered-list',
  'list-item',
  'table',
  'table-row',
  'table-header-cell',
  'table-cell',
  'embedded-entry-block',
  'embedded-asset-block',
]);
const INLINE_TYPES = new Set([
  'text',
  'hyperlink',
  'entry-hyperlink',
  'asset-hyperlink',
  'embedded-entry-inline',
]);
/** Embeds: dropped when their target is not imported (there is nothing to show). */
const EMBED_TYPES = new Set([
  'embedded-entry-block',
  'embedded-asset-block',
  'embedded-entry-inline',
]);
/** Links around text: unwrapped when their target is not imported (the words stay). */
const LINK_TYPES = new Set(['entry-hyperlink', 'asset-hyperlink']);

export interface RichTextContext {
  /** The new id of an entry or asset the import carries, or undefined. */
  resolve(linkType: LinkType, sourceId: string): string | undefined;
  /** A link the import cannot carry (target not in the export, or not imported). */
  missing(linkType: LinkType, sourceId: string): void;
  warn(message: string): void;
}

/**
 * Converts one document. Returns undefined for a value that is not a document at all (reported),
 * so the field is left empty rather than holding something no reader can render.
 */
export function convertRichText(
  value: unknown,
  ctx: RichTextContext,
  where: string,
): RichTextDocument | undefined {
  if (!isObject(value) || value.nodeType !== 'document' || !Array.isArray(value.content)) {
    ctx.warn(`${where}: not a rich-text document; left empty`);
    return undefined;
  }
  const unknown = new Map<string, number>();
  const content = value.content.flatMap((node) => convertNode(node, 'block', ctx, unknown));
  for (const [nodeType, count] of unknown) {
    ctx.warn(`${where}: ${count} "${nodeType}" node(s) have no equivalent; kept as plain text`);
  }
  const document: RichTextDocument = { nodeType: 'document', content, data: {} };
  // The walk keeps to the vocabulary, but a document can still be wrong in shape (a table with no
  // rows, a hyperlink with no URI): the field's validation refuses it, and the entry with it.
  for (const issue of validateRichText(document).slice(0, 3)) ctx.warn(`${where}: ${issue}`);
  return document;
}

function convertNode(
  raw: unknown,
  position: 'block' | 'inline',
  ctx: RichTextContext,
  unknown: Map<string, number>,
): RichTextNode[] {
  if (!isObject(raw) || typeof raw.nodeType !== 'string') return [];
  const nodeType = raw.nodeType;

  if (nodeType === 'text') {
    return [
      {
        nodeType: 'text',
        value: typeof raw.value === 'string' ? raw.value : '',
        marks: marksOf(raw.marks),
        data: {},
      },
    ];
  }

  const known = BLOCK_TYPES.has(nodeType) || INLINE_TYPES.has(nodeType);
  if (!known) {
    // A resource link into another space, or a node newer than this reader: its words survive as
    // text (a paragraph where a block stood), and the report counts it.
    unknown.set(nodeType, (unknown.get(nodeType) ?? 0) + 1);
    const text: RichTextNode = { nodeType: 'text', value: plainText(raw), marks: [], data: {} };
    return position === 'block' ? [{ nodeType: 'paragraph', content: [text], data: {} }] : [text];
  }

  const data = isObject(raw.data) ? raw.data : {};
  let converted: Json = {};
  const target = isObject(data.target) && isObject(data.target.sys) ? data.target.sys : undefined;
  if (EMBED_TYPES.has(nodeType) || LINK_TYPES.has(nodeType)) {
    const linkType = nodeType.includes('asset') ? 'Asset' : 'Entry';
    const sourceId = str(target?.id);
    const id = sourceId ? ctx.resolve(linkType, sourceId) : undefined;
    if (!id) {
      if (sourceId) ctx.missing(linkType, sourceId);
      return EMBED_TYPES.has(nodeType) ? [] : children(raw, 'inline', ctx, unknown);
    }
    converted = { target: { id, linkType } };
  } else if (nodeType === 'hyperlink') {
    const uri = typeof data.uri === 'string' ? safeLinkUri(data.uri) : undefined;
    // A script link is never stored; the words are.
    if (!uri) {
      ctx.warn(`a hyperlink to "${String(data.uri)}" is not a safe link; kept as text`);
      return children(raw, 'inline', ctx, unknown);
    }
    converted = { uri };
  } else if (nodeType === 'table-cell' || nodeType === 'table-header-cell') {
    for (const span of ['colspan', 'rowspan']) {
      if (Number.isInteger(data[span])) converted[span] = data[span];
    }
  }

  const childPosition = BLOCK_TYPES.has(nodeType) && !isTextBlock(nodeType) ? 'block' : 'inline';
  return [
    {
      nodeType,
      ...(nodeType === 'hr' || EMBED_TYPES.has(nodeType)
        ? { content: [] }
        : { content: children(raw, childPosition, ctx, unknown) }),
      data: converted,
    },
  ];
}

function children(
  raw: Json,
  position: 'block' | 'inline',
  ctx: RichTextContext,
  unknown: Map<string, number>,
): RichTextNode[] {
  return (Array.isArray(raw.content) ? raw.content : []).flatMap((c) =>
    convertNode(c, position, ctx, unknown),
  );
}

/** Blocks whose children are text runs rather than other blocks. */
function isTextBlock(nodeType: string): boolean {
  return nodeType === 'paragraph' || nodeType.startsWith('heading-');
}

function marksOf(raw: unknown): RichTextMark[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Json => isObject(m) && typeof m.type === 'string')
    .map((m) => ({ type: m.type as string }));
}

function plainText(node: Json): string {
  if (typeof node.value === 'string') return node.value;
  return (Array.isArray(node.content) ? node.content : [])
    .map((c) => (isObject(c) ? plainText(c) : ''))
    .join('');
}
