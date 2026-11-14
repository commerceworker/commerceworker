import { Ago } from '@commerceworker/content-admin/components/ago';
import { LoadingStatus, Refreshing } from '@commerceworker/content-admin/components/loading';
import { Empty } from '@commerceworker/content-admin/components/page';
import {
  type AuditEntry,
  type AuditLogFilters,
  apiErrorMessage,
} from '@commerceworker/content-admin/lib/management';
import {
  useAuditLogPagesQuery,
  useDebouncedValue,
  useInvalidate,
} from '@commerceworker/content-admin/lib/queries';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardHeader } from '@commerceworker/ui/card';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { SkeletonPill, SkeletonText } from '@commerceworker/ui/skeleton';
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
import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

/** The filter bar as typed: words, and `YYYY-MM-DD` days on the reader's clock. */
export interface AuditFilterState {
  readonly actor: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly from: string;
  readonly to: string;
}

const NO_FILTERS: AuditFilterState = {
  actor: '',
  action: '',
  targetType: '',
  targetId: '',
  from: '',
  to: '',
};

const COLUMNS = 6;

/** A day and time on the reader's clock as an exact time; a field mid-typing may be no date yet. */
function instant(local: string): string | undefined {
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** What the API is asked: a picked day runs from the reader's midnight to their next one. */
export function auditLogFilters(f: AuditFilterState): AuditLogFilters {
  const text = (value: string) => value.trim() || undefined;
  return {
    actor: text(f.actor),
    action: text(f.action),
    targetType: text(f.targetType),
    targetId: text(f.targetId),
    from: f.from ? instant(`${f.from}T00:00:00.000`) : undefined,
    to: f.to ? instant(`${f.to}T23:59:59.999`) : undefined,
  };
}

/** A row's value, pressed to filter the log by it: filters match exactly, so this is the way in. */
function FilterBy(props: {
  label: string;
  onPick: () => void;
  primary?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={props.label}
      data-row-primary={props.primary ? '' : undefined}
      onClick={props.onPick}
      className={`-mx-1 h-auto min-h-6 whitespace-normal break-all px-1 text-left font-normal pointer-coarse:my-2.5 ${props.className ?? ''}`}
    >
      {props.children}
    </Button>
  );
}

/** A row's locales as its line has room for them; its `title` has them all. */
const localesText = (locales: readonly string[]) =>
  locales.length > 2 ? `${locales.length} locales` : locales.join(', ');

/**
 * What a row's action changed, in the content model's words: one truncated line from md, its whole
 * text in the `title`, wrapped in full on a phone, where there is no `title` to reach. Only entry
 * saves say; other rows get a dash.
 */
function ChangedPaths({ detail }: { detail: AuditEntry['detail'] }) {
  const [entry, ...others] = detail?.entries ?? [];
  if (!detail) return <span>—</span>;
  if (!entry) return <span>Not recorded</span>;
  if (others.length > 0) {
    return (
      <span>
        {detail.truncated ? 'More than ' : ''}
        {others.length + 1} entries
      </span>
    );
  }
  const names = entry.paths.map((path) => path.replace(/^fields\./, ''));
  const undeclared = entry.undeclaredFields ?? 0;
  const nothing = entry.kind === 'created' ? 'Created with no fields' : 'No field changed';
  const whole = [names.join(', '), entry.locales.join(', ')].filter(Boolean).join(' in ');
  return (
    <div className="min-w-0 md:max-w-64">
      {names.length > 0 ? (
        <p title={whole} className="flex items-baseline gap-1.5 max-md:flex-wrap">
          <span className="min-w-0 break-all font-mono md:truncate">{names.join(', ')}</span>
          {entry.locales.length > 0 ? (
            <span className="shrink-0">
              in <span className="font-mono">{localesText(entry.locales)}</span>
            </span>
          ) : null}
        </p>
      ) : undeclared === 0 && !detail.truncated ? (
        <p>{nothing}</p>
      ) : null}
      {undeclared > 0 ? (
        <p>
          {undeclared} {undeclared === 1 ? 'field' : 'fields'} no longer in the model
        </p>
      ) : null}
      {detail.truncated ? <p>Other changes not listed</p> : null}
    </div>
  );
}

/** Append-only audit trail of mutating API actions (governance; space:admin). */
export function AuditLog() {
  const id = useId();
  const invalidate = useInvalidate();
  const [filters, setFilters] = useState(NO_FILTERS);
  const set = (patch: Partial<AuditFilterState>) => setFilters((f) => ({ ...f, ...patch }));
  const filtering = Object.values(filters).some(Boolean);
  // Both Clear buttons go when they are pressed, so focus moves on to the first field.
  const firstField = useRef<HTMLInputElement>(null);
  const clear = () => {
    setFilters(NO_FILTERS);
    firstField.current?.focus();
  };

  // Typing re-keys the list once it pauses; the rows on screen stay until the new ones arrive.
  const debounced = useDebouncedValue(filters, 250);
  // A range that ends before it starts is said at the fields, and the list stays as it was.
  const backwards = Boolean(filters.from && filters.to && filters.from > filters.to);
  const applied = useRef(debounced);
  if (!(debounced.from && debounced.to && debounced.from > debounced.to)) {
    applied.current = debounced;
  }
  const query = auditLogFilters(applied.current);

  const pages = useAuditLogPagesQuery(query);
  const entries = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const loading = pages.isPending;
  // isFetching (not isPending) so the Refresh button also disables during
  // button-triggered refetches, not just the first load.
  const refreshing = pages.isFetching;
  const load = () => void invalidate(['audit-log']);

  // Load more hands focus to the first row it brought, so the keyboard carries on from there; to
  // the last row if it brought none and took the button with it. A new filter forgets the hand-off.
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const focusFrom = useRef<number | null>(null);
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    focusFrom.current = null;
  }, [queryKey]);
  const fetchingMore = pages.isFetchingNextPage;
  const moreToRead = pages.hasNextPage;
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || fetchingMore) return;
    focusFrom.current = null;
    const rows = bodyRef.current?.querySelectorAll<HTMLElement>('[data-row-primary]');
    (rows?.[from] ?? (moreToRead ? undefined : rows?.[rows.length - 1]))?.focus();
  }, [fetchingMore, moreToRead]);

  const field = (name: keyof AuditFilterState, label: string, type = 'search') => (
    <div className="space-y-1">
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      <Input
        id={`${id}-${name}`}
        ref={name === 'actor' ? firstField : undefined}
        type={type}
        max={type === 'date' ? '9999-12-31' : undefined}
        value={filters[name]}
        onChange={(e) => set({ [name]: e.target.value })}
        aria-invalid={type === 'date' && backwards ? true : undefined}
        aria-describedby={type === 'date' ? `${id}-range` : undefined}
        enterKeyHint={type === 'date' ? undefined : 'search'}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
    </div>
  );

  // A failed first read is said as one, never as a log with nothing in it. Rows from the last
  // filter, still up while this one reads, say nothing about whether it matched.
  const failed = pages.isError && !pages.data;
  const answered = !loading && !failed && !pages.isPlaceholderData;
  const missed = answered && entries.length === 0;
  const nothingYet = missed && !Object.values(query).some(Boolean);

  return (
    // Clipped, not hidden: a long log keeps its header under the shell's as it scrolls.
    <Card className="overflow-clip">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div>
          <h2 className="font-heading font-medium text-base">Audit log</h2>
          <p className="max-w-measure text-muted-foreground text-sm">
            Every mutating API action in this space, newest first, with the fields an entry save
            changed. Press an actor, action or target to filter by it.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={load} disabled={refreshing}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <search aria-label="Filter the audit log" className="block space-y-2">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
            {field('actor', 'Actor')}
            {field('action', 'Action')}
            {field('targetType', 'Target type')}
            {field('targetId', 'Target ID')}
            {field('from', 'From', 'date')}
            {field('to', 'To', 'date')}
          </div>
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
            {backwards ? (
              <p key="error" id={`${id}-range`} role="alert" className="text-destructive text-sm">
                To is before From.
              </p>
            ) : (
              <p key="hint" id={`${id}-range`} className="text-muted-foreground text-sm">
                Days are on your clock.
              </p>
            )}
            {filtering ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={clear}
              >
                <X aria-hidden="true" />
                Clear filters
              </Button>
            ) : null}
          </div>
        </search>
        {failed ? (
          <Alert variant="destructive">
            <AlertTitle>The audit log didn’t load</AlertTitle>
            <AlertDescription>
              <p>{apiErrorMessage(pages.error)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void pages.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : nothingYet ? (
          <Empty>No audit entries yet.</Empty>
        ) : (
          <Refreshing busy={pages.isPlaceholderData}>
            <Table
              edge="flush"
              stack="cards"
              sticky
              caption="Audit log"
              aria-busy={loading || undefined}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Changed</TableHead>
                  <TableHead numeric className="w-16">
                    Status
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody ref={bodyRef}>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground text-xs">
                      <Ago at={e.at} />
                    </TableCell>
                    <TableCell label="Actor">
                      <FilterBy
                        primary
                        label={`Filter by actor ${e.actor}`}
                        onPick={() => set({ actor: e.actor })}
                      >
                        <Badge variant="outline">{e.actor}</Badge>
                      </FilterBy>
                    </TableCell>
                    <TableCell label="Action">
                      <FilterBy
                        label={`Filter by action ${e.action}`}
                        onPick={() => set({ action: e.action })}
                        className="font-mono"
                      >
                        {e.action}
                      </FilterBy>
                    </TableCell>
                    <TableCell label="Target" className="text-muted-foreground text-xs">
                      {e.targetType ? <span className="mr-2">{e.targetType}</span> : null}
                      {e.targetId ? (
                        <FilterBy
                          label={`Filter by target ${e.targetId}`}
                          onPick={() =>
                            set({ targetId: e.targetId ?? '', targetType: e.targetType ?? '' })
                          }
                          className="font-mono text-muted-foreground"
                        >
                          {e.targetId}
                        </FilterBy>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell label="Changed" className="text-muted-foreground text-xs">
                      <ChangedPaths detail={e.detail} />
                    </TableCell>
                    <TableCell label="Status" numeric>
                      {e.status}
                    </TableCell>
                  </TableRow>
                ))}
                {missed ? (
                  <TableEmpty colSpan={COLUMNS}>
                    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                      No audit entries match these filters.
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="px-0"
                        onClick={clear}
                      >
                        Clear filters
                      </Button>
                    </span>
                  </TableEmpty>
                ) : null}
                {loading
                  ? ['48%', '62%', '40%', '55%', '44%'].map((w) => (
                      <TableRow key={w} aria-hidden="true">
                        <TableCell className="text-xs">
                          <SkeletonText width="4.5rem" />
                        </TableCell>
                        <TableCell label="Actor">
                          <SkeletonPill className="w-20" />
                        </TableCell>
                        <TableCell label="Action" className="text-xs">
                          <SkeletonText width="7.5rem" />
                        </TableCell>
                        <TableCell label="Target" className="text-xs">
                          <SkeletonText width={w} />
                        </TableCell>
                        <TableCell label="Changed" className="text-xs">
                          <SkeletonText width="5rem" />
                        </TableCell>
                        <TableCell label="Status" numeric className="text-sm">
                          <SkeletonText width="1.75rem" className="items-end" />
                        </TableCell>
                      </TableRow>
                    ))
                  : null}
              </TableBody>
              {moreToRead && !loading && !pages.isPlaceholderData ? (
                <TableFoot className="max-md:block">
                  <TableRow className="border-t max-md:block">
                    <TableCell colSpan={COLUMNS} className="py-2 text-center max-md:block">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={fetchingMore}
                        onClick={() => {
                          focusFrom.current = entries.length;
                          void pages.fetchNextPage();
                        }}
                      >
                        {fetchingMore ? 'Loading more…' : 'Load more'}
                      </Button>
                    </TableCell>
                  </TableRow>
                </TableFoot>
              ) : null}
            </Table>
          </Refreshing>
        )}
        {/* Always mounted: what a filter found is read out, not only drawn. */}
        <LoadingStatus>
          {loading
            ? 'Loading the audit log…'
            : answered
              ? `${entries.length}${moreToRead ? '+' : ''} audit entries shown`
              : ''}
        </LoadingStatus>
      </CardContent>
    </Card>
  );
}
