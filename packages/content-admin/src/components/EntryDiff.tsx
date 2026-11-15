import { Button } from '@commerceworker/ui/button';
import { cn } from '@commerceworker/ui/lib/utils';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@commerceworker/ui/table';
import { useId, useState } from 'react';

/** A rich-text document's words, block by block (`nodeType`/`value`/`content`). */
function richText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { nodeType?: unknown; value?: unknown; content?: unknown; data?: unknown };
  if (n.nodeType === 'text') return typeof n.value === 'string' ? n.value : '';
  // External media reads as its title and URL, so swapping one video for another shows.
  if (n.nodeType === 'embed') {
    const { title, url } = (n.data ?? {}) as { title?: unknown; url?: unknown };
    const link = typeof url === 'string' ? url : '';
    return typeof title === 'string' && title ? `${title} (${link})` : link;
  }
  const parts = Array.isArray(n.content) ? n.content.map(richText) : [];
  // Blocks under the document break onto their own lines; inline runs join as they are.
  return n.nodeType === 'document' ? parts.filter(Boolean).join('\n') : parts.join('');
}

/** What a link points at, as a store holds it (`{ id, linkType }`) or Delivery writes it (`sys`). */
export function linkOf(v: unknown): { id: string; linkType: string } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { id?: unknown; linkType?: unknown; sys?: Record<string, unknown> };
  const { id, linkType } = o.sys?.type === 'Link' ? o.sys : o;
  return typeof id === 'string' && (linkType === 'Entry' || linkType === 'Asset')
    ? { id, linkType }
    : null;
}

/** The titles links resolve to, by the id of what they point at. */
export type LinkTitles = ReadonlyMap<string, string>;

/**
 * A field value as words a reviewer can read: text as it is, a rich-text document as its text, a
 * link by the title of what it points at when `titles` has it, a list joined; anything else as
 * JSON. Empty for nothing.
 */
export function valueText(v: unknown, titles?: LinkTitles): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v))
    return v
      .map((x) => valueText(x, titles))
      .filter(Boolean)
      .join(', ');
  if (typeof v === 'object') {
    if ((v as { nodeType?: unknown }).nodeType === 'document') return richText(v);
    const link = linkOf(v);
    if (link)
      return titles?.get(link.id) ?? (link.linkType === 'Asset' ? 'Linked asset' : 'Linked entry');
  }
  return JSON.stringify(v, null, 2);
}

/** Past this many characters or lines a value folds behind "Show all". */
const FOLD_CHARS = 280;
const FOLD_LINES = 4;

/**
 * One field value, folded to a few lines with a "Show all" disclosure when it is long, so a long
 * body never pushes the decision off the screen. An empty value says so in words.
 */
export function FieldValue({ value, muted }: { value: unknown; muted?: boolean }) {
  const text = valueText(value);
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!text) return <span className="text-muted-foreground italic">Empty</span>;
  const long = text.length > FOLD_CHARS || text.split('\n').length > FOLD_LINES;
  return (
    <div className="min-w-0">
      <p
        id={id}
        className={cn(
          // `anywhere`, not `break-words`: an unbroken URL must not widen what holds it.
          'wrap-anywhere whitespace-pre-wrap',
          muted && 'text-muted-foreground',
          long && !open && 'line-clamp-4',
        )}
      >
        {text}
      </p>
      {long ? (
        <Button
          variant="link"
          size="xs"
          className="px-0"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Show less' : 'Show all'}
        </Button>
      ) : null}
    </div>
  );
}

/** One field's before and after, named for a person (`label`) with an optional mono detail. */
export interface FieldChange {
  readonly key: string;
  readonly label: string;
  /** Secondary, in mono: a locale, say. Never the field's only name. */
  readonly detail?: string;
  readonly before: unknown;
  readonly after: unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A before/after table of field changes: what the entry holds now beside what would replace it,
 * for an agent's proposal, on a page of its own. Rows stack into cards on a phone.
 */
export function FieldChanges(props: {
  changes: readonly FieldChange[];
  caption: string;
  beforeLabel?: string;
  afterLabel?: string;
}) {
  const before = props.beforeLabel ?? 'Current';
  const after = props.afterLabel ?? 'Proposed';
  return (
    <Table stack="cards" caption={props.caption}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-40">Field</TableHead>
          <TableHead>{before}</TableHead>
          <TableHead>{after}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.changes.map((c) => (
          <TableRow key={c.key}>
            <TableCell className="align-top">
              <span className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-medium">{c.label}</span>
                {c.detail ? (
                  <span className="font-mono text-muted-foreground text-xs">{c.detail}</span>
                ) : null}
              </span>
              {same(c.before, c.after) ? (
                <span className="block text-muted-foreground text-xs">No change</span>
              ) : null}
            </TableCell>
            <TableCell label={before} className="align-top max-md:basis-full">
              <FieldValue value={c.before} muted />
            </TableCell>
            <TableCell label={after} className="align-top max-md:basis-full">
              <FieldValue value={c.after} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
