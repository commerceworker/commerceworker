import { Ago } from '@commerceworker/content-admin/components/ago';
import { StatusBadge } from '@commerceworker/content-admin/components/status';
import { Link } from '@commerceworker/content-admin/router';
import type { ContentType, FieldDefinition, FieldType } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { Checkbox } from '@commerceworker/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@commerceworker/ui/dropdown-menu';
import { Kbd } from '@commerceworker/ui/kbd';
import { Skeleton, SkeletonPill, SkeletonText } from '@commerceworker/ui/skeleton';
import {
  Table,
  TableBody,
  Td as TableCell,
  TableEmpty,
  TableFoot,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@commerceworker/ui/table';
import { MoreHorizontalIcon } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { plural } from '../../lib/format';
import type { EntryOrder, PreviewEntry } from '../../lib/management';
import { plainKeyAllowed, type ShortcutGroup, usePageShortcuts } from '../../lib/shortcuts';

/**
 * The entries list's single-key shortcuts. They live on the route (not
 * globally), only fire while the list shows, and appear in the "?" list then.
 */
export const ENTRIES_LIST_SHORTCUTS: ShortcutGroup = {
  id: 'entries-list',
  title: 'Entries list',
  items: [
    { keys: ['J'], label: 'Next entry (or ↓)' },
    { keys: ['K'], label: 'Previous entry (or ↑)' },
    { keys: ['Enter'], label: 'Open entry' },
    { keys: ['X'], label: 'Select or deselect entry' },
  ],
};

/** Whether single-key shortcuts should leave this key press alone. */
export function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  return !plainKeyAllowed(event);
}

export interface EntryRowActions {
  publish(entry: PreviewEntry): void;
  diff(entry: PreviewEntry): void;
  duplicate(entry: PreviewEntry): void;
  unpublish(entry: PreviewEntry): void;
  trash(entry: PreviewEntry): void;
  restore(entry: PreviewEntry): void;
  purge(entry: PreviewEntry): void;
}

/** The columns a header sorts by: the display field, the status, and when it last changed. */
export const SORT_STATUS = 'sys.status';
export const SORT_UPDATED = 'sys.updatedAt';

/** What a list shows besides the title when nobody picked: the status, then when it changed. */
export const DEFAULT_COLUMNS: readonly string[] = [SORT_STATUS, SORT_UPDATED];

/** The field types a list can sort by; the rest have no one value to put in order. */
const SORTABLE_FIELDS: ReadonlySet<FieldType> = new Set<FieldType>([
  'Symbol',
  'Text',
  'Integer',
  'Number',
  'Date',
  'Boolean',
]);

/** What a cell says for a value it can't show, by the field's type. */
const SUMMARY_WORDS: Partial<Record<FieldType, string>> = {
  RichText: 'Rich text',
  Location: 'Location',
  Seo: 'SEO',
  JSON: 'JSON',
  Component: 'Component',
};

/** A field's value as a cell shows it; `summary` when that says what it is, not what it holds. */
export interface FieldCell {
  readonly text: string;
  readonly summary?: true;
}

/**
 * A field's value as one line of a cell: text as it is, numbers, Yes or No, a list joined. What
 * doesn't fit a line is named instead (a count of links or items, "Rich text"): the editor shows it.
 */
export function fieldCell(value: unknown, field?: Pick<FieldDefinition, 'type'>): FieldCell | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return { text: value };
  if (typeof value === 'number') return { text: String(value) };
  if (typeof value === 'boolean') return { text: value ? 'Yes' : 'No' };
  const isLink = (v: unknown) =>
    !!v && typeof v === 'object' && 'linkType' in (v as Record<string, unknown>);
  if (isLink(value)) return { text: '1 link', summary: true };
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every(isLink)) return { text: plural(value.length, 'link', 'links'), summary: true };
    if (value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return { text: value.join(', ') };
    }
    return { text: plural(value.length, 'item', 'items'), summary: true };
  }
  return { text: (field && SUMMARY_WORDS[field.type]) ?? 'Details', summary: true };
}

export interface EntriesTableProps {
  readonly type: ContentType;
  readonly entries: readonly PreviewEntry[];
  readonly locale: string;
  readonly picked: ReadonlySet<string>;
  readonly busy: boolean;
  readonly viewingTrash: boolean;
  /** Editor URL for an entry; the title links here. */
  hrefFor(entry: PreviewEntry): string;
  /** Ticks (or unticks) these entries: one checkbox, X, or a shift-click range. */
  onPick(ids: readonly string[], picked: boolean): void;
  onPickAll(all: boolean): void;
  readonly actions: EntryRowActions;
  /** The list's sort, drawn on its column header; none is least recently changed first. */
  readonly order?: EntryOrder;
  /** Sorts by a column from its header. Without it the headers are plain captions. */
  onSort?(field: string): void;
  /** Reads the next page onto the end. Shown in the table's foot while there is more. */
  onLoadMore?(): void;
  readonly loadingMore?: boolean;
  /** Says why there are no rows (a search that missed), in a row under the headers. */
  readonly empty?: ReactNode;
  /** Skeleton rows to draw after the entries: the first page, before it has arrived. */
  readonly pending?: number;
  /**
   * The columns after the title, in order: `sys.status`, `sys.updatedAt` or a field's apiId (the
   * column picker's choice, which a saved view keeps). Absent is {@link DEFAULT_COLUMNS}.
   */
  readonly columns?: readonly string[];
}

/** The entry's display-field value in `locale`, or null when it has none. */
export function entryTitle(type: ContentType, entry: PreviewEntry, locale: string): string | null {
  const value = (entry.fields[type.displayField] as Record<string, unknown> | undefined)?.[locale];
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

export const needsPublish = (status: string) => status === 'draft' || status === 'changed';

/** The columns around the picked ones: checkbox, title, the contextual action, the menu. */
const FIXED_COLUMNS = 4;

// Below md each row is a card: the checkbox and title on the first line, the
// status, when it changed and the actions beneath. The header stays for screen
// readers, and the explicit roles keep table semantics through the display change.
// From md every row is one height, its cells centred on it.
const ROW_STACK =
  'group/row md:h-11 max-md:grid max-md:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] max-md:items-center max-md:gap-x-2 max-md:gap-y-1.5 max-md:py-2';
const CELL_STACK = 'max-md:block max-md:p-0';
// The second line of a row's card, placed by column so a view's own column order (or leaving one
// out) can't push the status onto a line of its own.
const STATUS_CELL = `${CELL_STACK} max-md:col-start-2 max-md:row-start-2`;
const UPDATED_CELL = `${CELL_STACK} max-md:col-start-3 max-md:row-start-2`;
const ACTION_CELL = `${CELL_STACK} max-md:col-start-4 max-md:row-start-2 text-right`;
const MENU_CELL = `${CELL_STACK} max-md:col-start-5 max-md:row-start-2 text-right`;

/**
 * The row's Publish is quiet: a ghost at badge height, shown on the row a pointer is over, the row
 * focus is in, the J/K row and a ticked one. A touch screen has no hover, so there it always shows.
 */
const QUIET_ACTION =
  'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-active/row:opacity-100 group-data-[state=selected]/row:opacity-100 touch:opacity-100 max-md:opacity-100';

/**
 * Entries table: the title opens the entry, one fixed-position contextual
 * action (Publish, or Restore in the trash), everything else in a per-row menu.
 * J/K (or the arrows once a row has focus) move between rows, Enter opens, X
 * selects; shift-click ticks a range. Title, Status and Updated sort from their
 * headers. Load more, in the foot, reads the next page onto the end.
 */
export function EntriesTable(props: EntriesTableProps) {
  const { type, entries, locale, picked, busy, viewingTrash, actions } = props;
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const keysId = useId();
  usePageShortcuts(ENTRIES_LIST_SHORTCUTS);
  const latest = useRef(props);
  latest.current = props;
  // The active row, clamped so a shorter list (after a filter) never points past its end.
  const activeRef = useRef<number | null>(null);
  activeRef.current = active !== null && active < entries.length ? active : null;
  // Where the last checkbox click was, for a shift-click range.
  const anchor = useRef<string | null>(null);
  // Load more hands focus to the first row it brought, so the keyboard carries on from there.
  const focusFrom = useRef<number | null>(null);

  const fieldName = type.fields.find((f) => f.apiId === type.displayField)?.name;
  const titleHeader = fieldName ?? type.displayField;
  // A column naming a field the type no longer has (a view saved before it was removed) is left out.
  const columns = (props.columns ?? DEFAULT_COLUMNS).filter(
    (c) => c === SORT_STATUS || c === SORT_UPDATED || type.fields.some((f) => f.apiId === c),
  );
  const columnCount = FIXED_COLUMNS + columns.length;
  // A phone's card always says the status, whichever columns were picked: it is how a row reads.
  const statusPicked = columns.includes(SORT_STATUS);
  const fieldOf = (apiId: string) => type.fields.find((f) => f.apiId === apiId);
  const pickedHere = entries.filter((e) => picked.has(e.id)).length;
  const allState =
    entries.length > 0 && pickedHere === entries.length
      ? true
      : pickedHere > 0
        ? ('indeterminate' as const)
        : false;

  // Keyboard navigation lives on the document so J/K work from anywhere on the
  // route, but the arrows only take over once focus is inside a row (elsewhere
  // they keep scrolling the page). Enter needs no handler: J/K focus the row's
  // title link, which opens the entry natively.
  useEffect(() => {
    const focusRow = (index: number) => {
      const rows = bodyRef.current?.querySelectorAll<HTMLElement>('[data-row-primary]');
      const target = rows?.[index];
      if (!target) return;
      target.focus();
      target.scrollIntoView?.({ block: 'nearest' });
      setActive(index);
    };
    const onKey = (event: KeyboardEvent) => {
      // The trash has nothing to open; its only row action (Restore) is a
      // write, which J then Enter must never trigger.
      if (shouldIgnoreShortcut(event) || latest.current.viewingTrash) return;
      const count = latest.current.entries.length;
      if (count === 0) return;
      const inRow =
        event.target instanceof Node && bodyRef.current?.contains(event.target as Node) === true;
      const current = inRow ? activeRef.current : null;
      const key = event.key;
      if (key === 'j' || key === 'J' || (inRow && key === 'ArrowDown')) {
        event.preventDefault();
        focusRow(current === null ? 0 : Math.min(current + 1, count - 1));
      } else if (key === 'k' || key === 'K' || (inRow && key === 'ArrowUp')) {
        event.preventDefault();
        focusRow(current === null ? 0 : Math.max(current - 1, 0));
      } else if ((key === 'x' || key === 'X') && current !== null) {
        const entry = latest.current.entries[current];
        if (!entry) return;
        event.preventDefault();
        anchor.current = entry.id;
        latest.current.onPick([entry.id], !latest.current.picked.has(entry.id));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // Live props are read through refs, so the listener is bound once.
  }, []);

  // A page arrived after Load more: focus the first new row (the button may be gone).
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || entries.length <= from) return;
    focusFrom.current = null;
    const rows = bodyRef.current?.querySelectorAll<HTMLElement>('[data-row-primary]');
    rows?.[from]?.focus();
    setActive(from);
  }, [entries.length]);

  const pickFromCheckbox = (index: number, shift: boolean) => {
    const entry = entries[index];
    if (!entry) return;
    const value = !picked.has(entry.id);
    const from = shift && anchor.current ? entries.findIndex((e) => e.id === anchor.current) : -1;
    anchor.current = entry.id;
    if (from < 0) return props.onPick([entry.id], value);
    const [lo, hi] = from < index ? [from, index] : [index, from];
    props.onPick(
      entries.slice(lo, hi + 1).map((e) => e.id),
      value,
    );
  };

  const sortOf = (field: string): 'ascending' | 'descending' | undefined => {
    const order = props.order;
    // No order is the default: least recently changed first.
    if (!order) return field === SORT_UPDATED ? 'ascending' : undefined;
    if (order.field !== field) return undefined;
    return order.direction === 'asc' ? 'ascending' : 'descending';
  };
  const sortable = (field: string) => {
    if (field === SORT_STATUS || field === SORT_UPDATED) return true;
    const declared = fieldOf(field);
    return declared !== undefined && SORTABLE_FIELDS.has(declared.type);
  };
  const header = (field: string, label: ReactNode, className?: string) => {
    const canSort = props.onSort !== undefined && sortable(field);
    const sort = canSort ? sortOf(field) : undefined;
    return (
      <TableHead role="columnheader" scope="col" sort={sort} className={className}>
        {canSort ? (
          <button
            type="button"
            className="hit-area caption -mx-1 rounded-sm px-1 hover:text-foreground"
            onClick={() => props.onSort?.(field)}
          >
            {label}
          </button>
        ) : (
          label
        )}
      </TableHead>
    );
  };

  return (
    <div className="space-y-2">
      <div className="card overflow-clip">
        {/* `stack="rows"`: on a phone each row lays itself out (a grid), keeping its
          table roles; the card runs the rows edge to edge. */}
        <Table
          stack="rows"
          sticky
          caption={`${type.name} entries`}
          aria-describedby={viewingTrash ? undefined : keysId}
          className="max-md:block [&_td]:align-middle"
        >
          <TableHeader role="rowgroup" className="max-md:sr-only">
            <TableRow role="row">
              <TableHead role="columnheader" scope="col" className="w-8">
                <Checkbox
                  aria-label="Select all entries"
                  checked={allState}
                  disabled={entries.length === 0}
                  onCheckedChange={() => props.onPickAll(allState !== true)}
                />
              </TableHead>
              {header(type.displayField, titleHeader)}
              {columns.map((c) =>
                c === SORT_STATUS ? (
                  <Fragment key={c}>{header(SORT_STATUS, 'Status', 'w-28')}</Fragment>
                ) : c === SORT_UPDATED ? (
                  <Fragment key={c}>{header(SORT_UPDATED, 'Updated', 'w-28')}</Fragment>
                ) : (
                  <Fragment key={c}>{header(c, fieldOf(c)?.name ?? c)}</Fragment>
                ),
              )}
              <TableHead role="columnheader" scope="col" className="w-24">
                <span className="sr-only">Action</span>
              </TableHead>
              <TableHead role="columnheader" scope="col" className="w-10">
                <span className="sr-only">More actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody ref={bodyRef} role="rowgroup" className="max-md:block">
            {entries.map((e, i) => {
              const title = entryTitle(type, e, locale);
              const name = title ?? 'untitled entry';
              const quoted = title ? `“${title}”` : 'untitled entry';
              return (
                <TableRow
                  key={e.id}
                  role="row"
                  data-active={activeRef.current === i || undefined}
                  data-state={picked.has(e.id) ? 'selected' : undefined}
                  onFocus={() => setActive(i)}
                  onBlur={(ev) => {
                    // Focus leaving the row (not moving within it) drops the highlight.
                    if (!ev.currentTarget.contains(ev.relatedTarget as Node | null))
                      setActive(null);
                  }}
                  className={ROW_STACK}
                >
                  <TableCell
                    role="cell"
                    className={`${CELL_STACK} max-md:row-span-2 max-md:self-start max-md:pt-0.5`}
                  >
                    <Checkbox
                      aria-label={`Select ${quoted}`}
                      checked={picked.has(e.id)}
                      // A click (or Space) carries Shift, which a range needs; the checked
                      // state follows `picked`.
                      onClick={(ev) => {
                        ev.preventDefault();
                        pickFromCheckbox(i, ev.shiftKey);
                      }}
                    />
                  </TableCell>
                  <TableCell
                    role="cell"
                    className={`whitespace-normal ${CELL_STACK} max-md:col-span-4`}
                  >
                    {viewingTrash ? (
                      <span className={title ? 'font-medium' : 'text-muted-foreground'}>
                        {title ?? 'Untitled entry'}
                      </span>
                    ) : (
                      <Link
                        to={props.hrefFor(e)}
                        data-row-primary=""
                        className={`rounded-sm font-medium underline-offset-4 hover:underline focus-visible:underline ${title ? '' : 'text-muted-foreground'}`}
                      >
                        {title ?? 'Untitled entry'}
                      </Link>
                    )}
                  </TableCell>
                  {columns.map((c) =>
                    c === SORT_STATUS ? (
                      <TableCell key={c} role="cell" className={STATUS_CELL}>
                        <StatusBadge status={e.status} />
                      </TableCell>
                    ) : c === SORT_UPDATED ? (
                      <TableCell
                        key={c}
                        role="cell"
                        className={`${UPDATED_CELL} whitespace-nowrap text-muted-foreground text-xs`}
                      >
                        {e.updatedAt ? <Ago at={e.updatedAt} /> : null}
                      </TableCell>
                    ) : (
                      <FieldTableCell
                        key={c}
                        value={(e.fields[c] as Record<string, unknown> | undefined)?.[locale]}
                        field={fieldOf(c)}
                      />
                    ),
                  )}
                  {!statusPicked && (
                    <TableCell role="cell" className={`${STATUS_CELL} md:hidden`}>
                      <StatusBadge status={e.status} />
                    </TableCell>
                  )}
                  <TableCell role="cell" className={ACTION_CELL}>
                    {viewingTrash ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => actions.restore(e)}
                        disabled={busy}
                      >
                        Restore
                      </Button>
                    ) : needsPublish(e.status) ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => actions.publish(e)}
                        disabled={busy}
                        aria-label={`Publish ${quoted}`}
                        className={QUIET_ACTION}
                      >
                        Publish
                      </Button>
                    ) : null}
                  </TableCell>
                  <TableCell role="cell" className={MENU_CELL}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`More actions for ${name}`}
                          disabled={busy}
                        >
                          <MoreHorizontalIcon aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-auto min-w-40">
                        {viewingTrash ? (
                          <DropdownMenuItem variant="destructive" onSelect={() => actions.purge(e)}>
                            Delete permanently…
                          </DropdownMenuItem>
                        ) : (
                          <>
                            {e.status !== 'draft' && (
                              <DropdownMenuItem onSelect={() => actions.diff(e)}>
                                Diff vs published
                              </DropdownMenuItem>
                            )}
                            {/* A singleton's copy would be its refused second entry. */}
                            {!type.singleton && (
                              <DropdownMenuItem onSelect={() => actions.duplicate(e)}>
                                Duplicate
                              </DropdownMenuItem>
                            )}
                            {e.status === 'published' && (
                              <DropdownMenuItem onSelect={() => actions.unpublish(e)}>
                                Unpublish
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => actions.trash(e)}
                            >
                              Move to trash
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
            {entries.length === 0 && props.empty ? (
              <TableEmpty colSpan={columnCount}>{props.empty}</TableEmpty>
            ) : null}
            {Array.from({ length: props.pending ?? 0 }, (_, i) => (
              <EntryRowSkeleton
                key={i}
                index={i}
                viewingTrash={viewingTrash}
                columns={columns}
                statusPicked={statusPicked}
              />
            ))}
          </TableBody>
          {props.onLoadMore ? (
            <TableFoot className="max-md:block">
              <TableRow className="border-t max-md:block">
                <TableCell colSpan={columnCount} className="py-2 text-center max-md:block">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={props.loadingMore}
                    onClick={() => {
                      focusFrom.current = entries.length;
                      props.onLoadMore?.();
                    }}
                  >
                    {props.loadingMore ? 'Loading more…' : 'Load more'}
                  </Button>
                </TableCell>
              </TableRow>
            </TableFoot>
          ) : null}
        </Table>
      </div>
      {!viewingTrash && (
        <>
          <p id={keysId} className="sr-only">
            Press J or K to move between entries, Enter to open one, and X to select it.
          </p>
          <p
            aria-hidden="true"
            className="hidden px-1 text-2xs text-muted-foreground fine:md:block"
          >
            <Kbd>J</Kbd> <Kbd>K</Kbd> to move, <Kbd>Enter</Kbd> to open, <Kbd>X</Kbd> to select
          </p>
        </>
      )}
    </div>
  );
}

/**
 * A picked field's cell. A phone's row card keeps to the title, status and actions. Long text is
 * cut to the column, and its `title` has the whole of it; what a cell only names has none.
 */
function FieldTableCell(props: { value: unknown; field?: FieldDefinition }) {
  const cell = fieldCell(props.value, props.field);
  return (
    <TableCell
      role="cell"
      title={cell && !cell.summary ? cell.text : undefined}
      className={`max-w-64 truncate max-md:hidden ${cell?.summary ? 'text-muted-foreground' : ''}`}
    >
      {cell?.text}
    </TableCell>
  );
}

/** Title lengths for skeleton rows, so a column of them reads as titles of different lengths. */
const TITLE_WIDTHS = ['58%', '42%', '71%', '50%', '64%', '37%'];

/**
 * A row still on its way, laid out by the real row's classes so nothing moves when it arrives:
 * the checkbox, the title, a status pill, when it changed, and Restore on each trashed row.
 */
function EntryRowSkeleton({
  index,
  viewingTrash,
  columns,
  statusPicked,
}: {
  index: number;
  viewingTrash: boolean;
  columns: readonly string[];
  statusPicked: boolean;
}) {
  const statusPill = <SkeletonPill className={index % 3 === 1 ? 'w-[5.5rem]' : 'w-[4.5rem]'} />;
  return (
    <TableRow role="row" aria-hidden="true" className={ROW_STACK}>
      <TableCell
        role="cell"
        className={`${CELL_STACK} max-md:row-span-2 max-md:self-start max-md:pt-0.5`}
      >
        <Skeleton className="size-4 rounded-[4px]" />
      </TableCell>
      <TableCell role="cell" className={`${CELL_STACK} max-md:col-span-4`}>
        <SkeletonText width={TITLE_WIDTHS[index % TITLE_WIDTHS.length]} />
      </TableCell>
      {columns.map((c) =>
        c === SORT_STATUS ? (
          <TableCell key={c} role="cell" className={STATUS_CELL}>
            {statusPill}
          </TableCell>
        ) : (
          <TableCell
            key={c}
            role="cell"
            className={c === SORT_UPDATED ? `${UPDATED_CELL} text-xs` : 'max-md:hidden'}
          >
            <SkeletonText width={c === SORT_UPDATED ? '3.5rem' : '5rem'} />
          </TableCell>
        ),
      )}
      {!statusPicked && (
        <TableCell role="cell" className={`${STATUS_CELL} md:hidden`}>
          {statusPill}
        </TableCell>
      )}
      <TableCell role="cell" className={ACTION_CELL}>
        {/* The row's Publish is hidden at rest; Restore, in the trash, always shows. */}
        {viewingTrash ? <SkeletonPill className="h-6 w-[4.25rem]" /> : null}
      </TableCell>
      <TableCell role="cell" className={MENU_CELL}>
        {/* The row menu's ghost button is only its icon at rest: hold its height, draw nothing. */}
        <span className="inline-block size-8 align-middle" />
      </TableCell>
    </TableRow>
  );
}
