/**
 * Bidirectional mapping between the stored rich-text document tree
 * (`RichTextDocument`, `nodeType`/`value`/`marks`) and Tiptap/ProseMirror JSON
 * (`type`/`text`/`marks` with attrs).
 *
 * Round-trip safety rules:
 * - Unmapped block nodes ride through an `unknownBlock` atom whose `raw` attr
 *   holds the stored node verbatim; unmapped inline nodes use `unknownInline`
 *   the same way (as do reference nodes missing their required target).
 *   Serializing emits `raw` back unchanged, so foreign/API-authored documents
 *   are never corrupted.
 * - Stored link nodes flatten to text runs carrying a link-kind mark
 *   (ProseMirror models links as marks): `hyperlink` → `link` (href),
 *   `entry-hyperlink` → `entryLink` and `asset-hyperlink` → `assetLink`
 *   (targetId). Serializing groups maximal runs of consecutive inline nodes
 *   with an identical link mark back into one stored node. Nested link nodes
 *   keep the innermost mark; stacked link marks resolve entryLink > assetLink
 *   > link.
 * - Unknown mark types are dropped on edit (text nodes can't carry raw data).
 *   The `code` mark is exclusive in ProseMirror: combined with other marks it
 *   wins, except inside a link where the link mark wins.
 * - Inline (text) children directly under block containers such as blockquote
 *   are wrapped in a paragraph, as ProseMirror requires block content there.
 * - Tables map node for node (`table` ⇄ table, `table-row` ⇄ tableRow,
 *   `table-header-cell` ⇄ tableHeader, `table-cell` ⇄ tableCell). A cell's
 *   `data.colspan`/`data.rowspan` ride as the cell attrs of the same name, so
 *   merged cells survive; column widths are not stored and are dropped. A table
 *   the domain wouldn't accept (`isWellFormedTable`) rides through `unknownBlock`
 *   instead, since the editor's table plugin would otherwise "fix" it by
 *   inventing or dropping cells.
 * - An `embed` (external media) maps to an `externalEmbed` atom whose `embed`
 *   attr holds its data. Serializing keeps only the embed data keys the domain
 *   knows, so nothing else (provider markup least of all) is ever written back.
 *   An embed the domain wouldn't accept rides through `unknownBlock`.
 */

import type { EmbedData, RichTextDocument, RichTextNode } from '@commerceworker/domain';
import { embedDataIssues, isRichTextDocument, isWellFormedTable } from '@commerceworker/domain';

/** Minimal ProseMirror JSON shape (matches @tiptap/core's JSONContent). */
export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const HEADING = /^heading-([1-6])$/;

/** Stored block containers whose children are themselves blocks. */
const BLOCK_CONTAINERS: Record<string, string> = {
  blockquote: 'blockquote',
  'unordered-list': 'bulletList',
  'ordered-list': 'orderedList',
  'list-item': 'listItem',
};
const PM_CONTAINERS: Record<string, string> = {
  blockquote: 'blockquote',
  bulletList: 'unordered-list',
  orderedList: 'ordered-list',
  listItem: 'list-item',
};

const CELL_TO_PM: Record<string, string> = {
  'table-header-cell': 'tableHeader',
  'table-cell': 'tableCell',
};
const PM_TO_CELL: Record<string, string> = {
  tableHeader: 'table-header-cell',
  tableCell: 'table-cell',
};
const SPANS = ['colspan', 'rowspan'] as const;
/** A span worth keeping: a whole number of cells past the one it always covers. */
const isSpan = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 1;

const EMBED_TO_PM: Record<string, string> = {
  'embedded-entry-block': 'embeddedEntryBlock',
  'embedded-asset-block': 'embeddedAssetBlock',
};
const PM_TO_EMBED: Record<string, { nodeType: string; linkType: 'Entry' | 'Asset' }> = {
  embeddedEntryBlock: { nodeType: 'embedded-entry-block', linkType: 'Entry' },
  embeddedAssetBlock: { nodeType: 'embedded-asset-block', linkType: 'Asset' },
};

/** The three link-kind marks; a run of inline nodes sharing one folds into a stored node. */
interface LinkKind {
  readonly mark: string;
  readonly attr: 'href' | 'targetId';
  readonly nodeType: string;
  readonly linkType?: 'Entry' | 'Asset';
}
// Order is the stacked-mark priority (first match wins on serialize).
const LINK_KINDS: readonly LinkKind[] = [
  { mark: 'entryLink', attr: 'targetId', nodeType: 'entry-hyperlink', linkType: 'Entry' },
  { mark: 'assetLink', attr: 'targetId', nodeType: 'asset-hyperlink', linkType: 'Asset' },
  { mark: 'link', attr: 'href', nodeType: 'hyperlink' },
];
const LINK_MARK_NAMES = new Set(LINK_KINDS.map((k) => k.mark));

const MARK_TO_PM: Record<string, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  code: 'code',
  strikethrough: 'strike',
};
const PM_TO_MARK: Record<string, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  code: 'code',
  strike: 'strikethrough',
};

// ---------------------------------------------------------------------------
// Stored → Tiptap
// ---------------------------------------------------------------------------

/** Converts a stored rich-text value into a ProseMirror doc for the editor. */
export function toTiptap(value: unknown): PmNode {
  if (!isRichTextDocument(value)) return { type: 'doc', content: [{ type: 'paragraph' }] };
  const content = blockChildrenToPm(value.content);
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

/**
 * Maps block-level children, wrapping stray inline runs in a paragraph.
 * ProseMirror content expressions are strict, so API-authored shapes are
 * normalized to stay schema-legal: inside a list, non-list-item children are
 * wrapped in a listItem; outside one, an orphan listItem gets a bulletList.
 */
function blockChildrenToPm(nodes: readonly RichTextNode[], parent?: 'list'): PmNode[] {
  const out: PmNode[] = [];
  const push = (pm: PmNode) => {
    if (parent === 'list' && pm.type !== 'listItem') {
      out.push({ type: 'listItem', content: [pm] });
    } else if (parent !== 'list' && pm.type === 'listItem') {
      out.push({ type: 'bulletList', content: [pm] });
    } else {
      out.push(pm);
    }
  };
  let inlineRun: PmNode[] = [];
  const flush = () => {
    if (inlineRun.length > 0) push({ type: 'paragraph', content: inlineRun });
    inlineRun = [];
  };
  for (const node of nodes) {
    if (isInlineStored(node)) {
      inlineRun.push(...inlineToPm(node));
    } else {
      flush();
      push(blockToPm(node));
    }
  }
  flush();
  return out;
}

function isInlineStored(node: RichTextNode): boolean {
  return (
    node.nodeType === 'text' ||
    node.nodeType === 'hard-break' ||
    node.nodeType === 'hyperlink' ||
    node.nodeType === 'entry-hyperlink' ||
    node.nodeType === 'asset-hyperlink' ||
    node.nodeType === 'embedded-entry-inline'
  );
}

function blockToPm(node: RichTextNode): PmNode {
  const heading = HEADING.exec(node.nodeType);
  if (heading) {
    return {
      type: 'heading',
      attrs: { level: Number(heading[1]) },
      content: inlineChildrenToPm(node.content ?? []),
    };
  }
  switch (node.nodeType) {
    case 'paragraph':
      return { type: 'paragraph', content: inlineChildrenToPm(node.content ?? []) };
    case 'code-block': {
      const text = (node.content ?? []).map((c) => c.value ?? '').join('');
      return {
        type: 'codeBlock',
        attrs: { language: (node.data?.language as string | null) ?? null },
        content: text ? [{ type: 'text', text }] : [],
      };
    }
    case 'hr':
      return { type: 'horizontalRule' };
    case 'table':
      return tableToPm(node) ?? { type: 'unknownBlock', attrs: { raw: node } };
    case 'embed':
      return embedDataIssues(node.data).length === 0 && !node.content?.length
        ? { type: 'externalEmbed', attrs: { embed: embedDataOf(node.data) } }
        : { type: 'unknownBlock', attrs: { raw: node } };
    default: {
      const container = BLOCK_CONTAINERS[node.nodeType];
      if (container) {
        const isList = container === 'bulletList' || container === 'orderedList';
        return {
          type: container,
          content: blockChildrenToPm(node.content ?? [], isList ? 'list' : undefined),
        };
      }
      const embed = EMBED_TO_PM[node.nodeType];
      if (embed) return { type: embed, attrs: { targetId: node.data?.target?.id ?? '' } };
      return { type: 'unknownBlock', attrs: { raw: node } };
    }
  }
}

/** The keys an embed stores; anything else on a node or an editor attr is dropped. */
const EMBED_KEYS = [
  'url',
  'provider',
  'kind',
  'title',
  'authorName',
  'thumbnail',
  'width',
  'height',
  'aspectRatio',
] as const satisfies readonly (keyof EmbedData)[];

/** An embed's data with only the keys the domain defines, in a stable order. */
export function embedDataOf(data: Readonly<Record<string, unknown>> | undefined): EmbedData {
  const out: Record<string, unknown> = {};
  for (const key of EMBED_KEYS) {
    if (data?.[key] !== undefined) out[key] = data[key];
  }
  return out as unknown as EmbedData;
}

/** The editor's table, or `undefined` when the stored one isn't well formed. */
function tableToPm(node: RichTextNode): PmNode | undefined {
  if (!isWellFormedTable(node)) return undefined;
  return {
    type: 'table',
    content: (node.content ?? []).map((row) => ({
      type: 'tableRow',
      content: (row.content ?? []).map((cell) => {
        const attrs = Object.fromEntries(
          SPANS.filter((s) => isSpan(cell.data?.[s])).map((s) => [s, cell.data?.[s]]),
        );
        return {
          type: CELL_TO_PM[cell.nodeType] as string,
          ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
          content: blockChildrenToPm(cell.content ?? []),
        };
      }),
    })),
  };
}

function inlineChildrenToPm(nodes: readonly RichTextNode[]): PmNode[] {
  return nodes.flatMap(inlineToPm);
}

function inlineToPm(node: RichTextNode): PmNode[] {
  switch (node.nodeType) {
    case 'text': {
      if (!node.value) return [];
      let marks = (node.marks ?? [])
        .map((m) => MARK_TO_PM[m.type])
        .filter((t): t is string => t !== undefined)
        .map((type) => ({ type }));
      // ProseMirror's code mark excludes all others; keep code, drop the rest.
      if (marks.length > 1 && marks.some((m) => m.type === 'code')) {
        marks = [{ type: 'code' }];
      }
      return [{ type: 'text', text: node.value, ...(marks.length > 0 ? { marks } : {}) }];
    }
    case 'hard-break':
      return [{ type: 'hardBreak' }];
    case 'hyperlink': {
      const uri = node.data?.uri;
      // A hyperlink without a uri can't form a link-mark run (marks need a
      // truthy value to group); carry it raw so the editor never drops it.
      // Saving it is refused by validation until the link is fixed.
      if (typeof uri !== 'string' || !uri) {
        return [{ type: 'unknownInline', attrs: { raw: node } }];
      }
      return linkChildrenToPm(node, 'link', uri);
    }
    case 'entry-hyperlink':
    case 'asset-hyperlink': {
      const targetId = node.data?.target?.id;
      // A reference link without its target is malformed; carry it raw.
      if (typeof targetId !== 'string' || !targetId) {
        return [{ type: 'unknownInline', attrs: { raw: node } }];
      }
      const mark = node.nodeType === 'entry-hyperlink' ? 'entryLink' : 'assetLink';
      return linkChildrenToPm(node, mark, targetId);
    }
    case 'embedded-entry-inline': {
      const targetId = node.data?.target?.id;
      if (typeof targetId !== 'string' || !targetId) {
        return [{ type: 'unknownInline', attrs: { raw: node } }];
      }
      return [{ type: 'embeddedEntryInline', attrs: { targetId } }];
    }
    default:
      return [{ type: 'unknownInline', attrs: { raw: node } }];
  }
}

/**
 * Flattens a stored link node's children, marking text/hardBreak with the link
 * mark so the node stays one run on the way back (atoms are left unmarked).
 * Children already carrying a link mark keep it — the innermost link wins.
 * The code mark excludes link, so it yields (losing the target would be worse).
 */
function linkChildrenToPm(node: RichTextNode, mark: string, value: string): PmNode[] {
  const attr = mark === 'link' ? 'href' : 'targetId';
  return (node.content ?? []).flatMap((child) =>
    inlineToPm(child).map((pm) => {
      if (pm.type !== 'text' && pm.type !== 'hardBreak') return pm;
      if ((pm.marks ?? []).some((m) => LINK_MARK_NAMES.has(m.type))) return pm;
      return {
        ...pm,
        marks: [
          ...(pm.marks ?? []).filter((m) => m.type !== 'code'),
          { type: mark, attrs: { [attr]: value } },
        ],
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Tiptap → Stored
// ---------------------------------------------------------------------------

/**
 * Converts the editor's ProseMirror doc back into a stored rich-text document,
 * or `undefined` when it holds no content (matches the form's empty-value drop).
 */
export function toDocument(json: PmNode): RichTextDocument | undefined {
  const content = (json.content ?? []).flatMap(pmToBlock);
  const isEmpty = content.every(
    (n) => n.nodeType === 'paragraph' && (n.content?.length ?? 0) === 0,
  );
  if (content.length === 0 || isEmpty) return undefined;
  return { nodeType: 'document', content };
}

function pmToBlock(node: PmNode): RichTextNode[] {
  switch (node.type) {
    case 'paragraph':
      return [{ nodeType: 'paragraph', content: pmInlineChildren(node.content ?? []) }];
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      return [{ nodeType: `heading-${level}`, content: pmInlineChildren(node.content ?? []) }];
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map((c) => c.text ?? '').join('');
      const language = node.attrs?.language;
      return [
        {
          nodeType: 'code-block',
          content: [{ nodeType: 'text', value: text, marks: [] }],
          ...(typeof language === 'string' && language ? { data: { language } } : {}),
        },
      ];
    }
    case 'horizontalRule':
      return [{ nodeType: 'hr', content: [] }];
    case 'unknownBlock':
      return node.attrs?.raw ? [node.attrs.raw as RichTextNode] : [];
    case 'externalEmbed': {
      const embed = node.attrs?.embed;
      if (!embed || typeof embed !== 'object') return [];
      return [
        {
          nodeType: 'embed',
          data: { ...embedDataOf(embed as Record<string, unknown>) },
          content: [],
        },
      ];
    }
    case 'table': {
      const rows = (node.content ?? []).flatMap(pmToBlock);
      return rows.length > 0 ? [{ nodeType: 'table', data: {}, content: rows }] : [];
    }
    case 'tableRow': {
      // The editor allows a row with no cells; the stored model does not.
      const cells = (node.content ?? []).flatMap(pmToBlock);
      return cells.length > 0 ? [{ nodeType: 'table-row', data: {}, content: cells }] : [];
    }
    case 'tableHeader':
    case 'tableCell': {
      const data = Object.fromEntries(
        SPANS.filter((s) => isSpan(node.attrs?.[s])).map((s) => [s, node.attrs?.[s]]),
      );
      const content = (node.content ?? []).flatMap(pmToBlock);
      return [
        {
          nodeType: PM_TO_CELL[node.type] as string,
          data,
          content: content.length > 0 ? content : [{ nodeType: 'paragraph', content: [] }],
        },
      ];
    }
    default: {
      const container = PM_CONTAINERS[node.type];
      if (container) {
        return [{ nodeType: container, content: (node.content ?? []).flatMap(pmToBlock) }];
      }
      const embed = PM_TO_EMBED[node.type];
      if (embed) {
        const id = typeof node.attrs?.targetId === 'string' ? node.attrs.targetId : '';
        if (!id) return [];
        return [
          {
            nodeType: embed.nodeType,
            data: { target: { id, linkType: embed.linkType } },
            content: [],
          },
        ];
      }
      // Unrecognized editor node: preserve nothing rather than invent structure.
      return [];
    }
  }
}

/** The link mark on an inline node, resolved by LINK_KINDS priority. */
function linkMarkOf(node: PmNode): { kind: LinkKind; value: string } | undefined {
  for (const kind of LINK_KINDS) {
    const mark = node.marks?.find((m) => m.type === kind.mark);
    const value = mark?.attrs?.[kind.attr];
    if (typeof value === 'string' && value) return { kind, value };
  }
  return undefined;
}

/** Maps inline content, grouping same-target link runs back into stored link nodes. */
function pmInlineChildren(nodes: PmNode[]): RichTextNode[] {
  const out: RichTextNode[] = [];
  let run: RichTextNode[] = [];
  let runLink: { kind: LinkKind; value: string } | undefined;
  const flushRun = () => {
    if (runLink !== undefined && run.length > 0) {
      const { kind, value } = runLink;
      const data = kind.linkType
        ? { target: { id: value, linkType: kind.linkType } }
        : { uri: value };
      out.push({ nodeType: kind.nodeType, data, content: run });
    }
    run = [];
    runLink = undefined;
  };
  for (const node of nodes) {
    const link = linkMarkOf(node);
    const mapped = pmToInline(node, link !== undefined);
    if (link !== undefined) {
      if (link.kind !== runLink?.kind || link.value !== runLink.value) flushRun();
      runLink = link;
      run.push(...mapped);
    } else {
      flushRun();
      out.push(...mapped);
    }
  }
  flushRun();
  return out;
}

function pmToInline(node: PmNode, stripLink: boolean): RichTextNode[] {
  switch (node.type) {
    case 'text': {
      if (!node.text) return [];
      const marks = (node.marks ?? [])
        .filter((m) => !(stripLink && LINK_MARK_NAMES.has(m.type)))
        .map((m) => PM_TO_MARK[m.type])
        .filter((t): t is string => t !== undefined)
        .map((type) => ({ type }));
      return [{ nodeType: 'text', value: node.text, marks }];
    }
    case 'hardBreak':
      return [{ nodeType: 'hard-break' }];
    case 'embeddedEntryInline': {
      const id = typeof node.attrs?.targetId === 'string' ? node.attrs.targetId : '';
      if (!id) return [];
      return [
        {
          nodeType: 'embedded-entry-inline',
          data: { target: { id, linkType: 'Entry' } },
          content: [],
        },
      ];
    }
    case 'unknownInline':
      return node.attrs?.raw ? [node.attrs.raw as RichTextNode] : [];
    default:
      return [];
  }
}
