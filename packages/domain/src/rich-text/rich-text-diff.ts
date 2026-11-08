/**
 * A rich-text diff a reader can follow: the two documents are read as their blocks (a paragraph,
 * a heading, one list item, one table row, an embed), the blocks are lined up, and a block that
 * changed carries a word-level diff of its text. The result is structured, never markup: each
 * consumer renders it as it renders the documents themselves.
 */

import {
  alignByContent,
  canonical,
  type DiffKind,
  diffText,
  type TextSegment,
} from '../entry/sequence-diff';
import {
  isRichTextDocument,
  RICH_TEXT_INLINE_NODE_TYPES,
  type RichTextNode,
  type RichTextTarget,
} from './rich-text';

/** One block of a rich-text diff, in the order the newer document reads. */
export interface RichTextBlockDiff {
  readonly kind: DiffKind;
  /** The block is in both versions but sits elsewhere among its neighbours. */
  readonly moved?: true;
  /** The block's node type (`paragraph`, `heading-2`, `list-item`, `table-row`, …). */
  readonly nodeType: string;
  /** What the block was before, when an edit changed its type (a paragraph made a heading). */
  readonly beforeNodeType?: string;
  /** List nesting: 0 for a top-level block, 1 for an item of a top-level list, and so on. */
  readonly depth: number;
  /** The block that holds it: `ordered-list`, `unordered-list` or `table`. */
  readonly container?: string;
  /**
   * The block's text as a word-level diff: the whole text, unchanged, added or removed, unless
   * the block changed. Table cells read as `a | b`; an embed as its title and URL.
   */
  readonly text: readonly TextSegment[];
  /** The text reads the same but its marks, links or data changed. */
  readonly formattingChanged?: true;
  /** The entry or asset an embedded block shows (after the change, when it changed). */
  readonly target?: RichTextTarget;
  /** The entry or asset the block showed before, when the change swapped it. */
  readonly beforeTarget?: RichTextTarget;
}

/** A block as the diff reads it. */
interface Unit {
  readonly nodeType: string;
  readonly depth: number;
  readonly container?: string;
  readonly text: string;
  readonly target?: RichTextTarget;
  /** The block's own content, for telling a formatting change from no change. */
  readonly signature: string;
}

const LISTS = new Set(['ordered-list', 'unordered-list']);
const INLINE: ReadonlySet<string> = new Set(RICH_TEXT_INLINE_NODE_TYPES);
const EMBEDDED_BLOCKS = new Set(['embedded-entry-block', 'embedded-asset-block']);

function inlineText(node: RichTextNode): string {
  if (node.nodeType === 'text') return node.value ?? '';
  if (node.nodeType === 'hard-break') return '\n';
  return (node.content ?? []).map(inlineText).join('');
}

/** A container's text: its blocks' text, one per line. */
function blockText(node: RichTextNode): string {
  const children = node.content ?? [];
  if (children.some((c) => INLINE.has(c.nodeType))) return inlineText(node);
  return children.map(blockText).filter(Boolean).join('\n');
}

function embedText(node: RichTextNode): string {
  const { title, url } = node.data ?? {};
  const link = typeof url === 'string' ? url : '';
  return typeof title === 'string' && title.trim() ? `${title.trim()} (${link})` : link;
}

function targetOf(node: RichTextNode): RichTextTarget | undefined {
  const t = node.data?.target;
  return t && typeof t.id === 'string' ? { id: t.id, linkType: t.linkType } : undefined;
}

/** A document's blocks, in reading order, with lists and tables opened up. */
function blocksOf(value: unknown): Unit[] {
  if (!isRichTextDocument(value)) return [];
  const units: Unit[] = [];
  const push = (node: RichTextNode, text: string, depth: number, container?: string) => {
    const target = EMBEDDED_BLOCKS.has(node.nodeType) ? targetOf(node) : undefined;
    units.push({
      nodeType: node.nodeType,
      depth,
      ...(container ? { container } : {}),
      text,
      ...(target ? { target } : {}),
      signature: canonical([node.nodeType, depth, container ?? null, node]),
    });
  };
  const walk = (node: RichTextNode, depth: number): void => {
    if (LISTS.has(node.nodeType)) {
      for (const item of node.content ?? []) {
        // An item is its own text; a list nested in it is a run of deeper items after it.
        const own = (item.content ?? []).filter((c) => !LISTS.has(c.nodeType));
        const self = { ...item, content: own };
        push(self, own.map(blockText).filter(Boolean).join('\n'), depth + 1, node.nodeType);
        for (const nested of item.content ?? []) {
          if (LISTS.has(nested.nodeType)) walk(nested, depth + 1);
        }
      }
    } else if (node.nodeType === 'table') {
      for (const row of node.content ?? []) {
        const cells = (row.content ?? []).map((cell) => blockText(cell).replace(/\s*\n\s*/g, ' '));
        push(row, cells.join(' | '), depth, 'table');
      }
    } else if (node.nodeType === 'embed') {
      push(node, embedText(node), depth);
    } else {
      push(node, blockText(node), depth);
    }
  };
  for (const node of value.content) walk(node, 0);
  return units;
}

const sameTarget = (a?: RichTextTarget, b?: RichTextTarget) =>
  a?.id === b?.id && a?.linkType === b?.linkType;

/**
 * The block-level diff of two rich-text values (either may be absent: every block is then added
 * or removed). Blocks are matched by content; an unmatched block of the same type (or the same
 * text) in the same stretch is the same block, edited; an identical block found elsewhere moved.
 */
export function diffRichText(before: unknown, after: unknown): RichTextBlockDiff[] {
  const a = blocksOf(before);
  const b = blocksOf(after);
  const aligned = alignByContent(
    a,
    b,
    (x, y) => x.signature === y.signature,
    (x, y) => x.nodeType === y.nodeType || (x.text !== '' && x.text === y.text),
  );
  return aligned.map(({ beforeIndex, afterIndex, moved }): RichTextBlockDiff => {
    const was = beforeIndex === null ? undefined : a[beforeIndex];
    const now = afterIndex === null ? undefined : b[afterIndex];
    const unit = (now ?? was) as Unit;
    const base = {
      nodeType: unit.nodeType,
      depth: unit.depth,
      ...(unit.container ? { container: unit.container } : {}),
      ...(unit.target ? { target: unit.target } : {}),
    };
    if (!was) return { kind: 'added', ...base, text: whole('added', unit.text) };
    if (!now) return { kind: 'removed', ...base, text: whole('removed', unit.text) };
    if (was.signature === now.signature) {
      return {
        kind: 'unchanged',
        ...(moved ? { moved: true } : {}),
        ...base,
        text: whole('unchanged', now.text),
      };
    }
    return {
      kind: 'changed',
      ...base,
      ...(was.nodeType !== now.nodeType ? { beforeNodeType: was.nodeType } : {}),
      text: diffText(was.text, now.text),
      ...(was.text === now.text && was.nodeType === now.nodeType
        ? { formattingChanged: true }
        : {}),
      ...(was.target && !sameTarget(was.target, now.target) ? { beforeTarget: was.target } : {}),
    };
  });
}

const whole = (kind: TextSegment['kind'], text: string): TextSegment[] =>
  text ? [{ kind, text }] : [];
