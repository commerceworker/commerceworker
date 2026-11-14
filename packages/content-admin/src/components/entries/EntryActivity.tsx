import { Ago } from '@commerceworker/content-admin/components/ago';
import { LoadingStatus, Refreshing } from '@commerceworker/content-admin/components/loading';
import { Empty } from '@commerceworker/content-admin/components/page';
import {
  type ActivityChange,
  activityAction,
  activityChange,
  pathLabel,
} from '@commerceworker/content-admin/lib/activity';
import { type ActorDirectory, actorLabel } from '@commerceworker/content-admin/lib/authorship';
import { type AuditEntry, apiErrorMessage } from '@commerceworker/content-admin/lib/management';
import {
  useEntryActivityPagesQuery,
  useInvalidate,
} from '@commerceworker/content-admin/lib/queries';
import type { ContentType } from '@commerceworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Card, CardAction, CardContent, CardHeader } from '@commerceworker/ui/card';
import { SkeletonText } from '@commerceworker/ui/skeleton';
import { useEffect, useMemo, useRef } from 'react';

/**
 * What a row changed in this entry, in the model's words. A row without `detail` (from before
 * changes were recorded, or an action that saves nothing, a publish) shows no line at all: it
 * says nothing about what changed, so it is never "no changes".
 */
function Changes(props: { change: ActivityChange; contentType?: ContentType }) {
  const { change } = props;
  if (change.kind === 'unrecorded') return null;
  if (change.kind === 'unlisted') {
    return <p className="text-muted-foreground text-xs">Its changes to this entry aren’t listed</p>;
  }
  const { paths, locales, kind, undeclaredFields = 0 } = change.change;
  const names = paths.map((p) => pathLabel(p, props.contentType));
  return (
    <div className="space-y-0.5 text-muted-foreground text-xs">
      {names.length > 0 ? (
        <p className="break-words">
          <span className="text-foreground">{names.join(', ')}</span>
          {locales.length > 0 ? (
            <>
              {' in '}
              <span className="font-mono">{locales.join(', ')}</span>
            </>
          ) : null}
        </p>
      ) : undeclaredFields === 0 && !change.truncated ? (
        <p>{kind === 'created' ? 'Created with no fields' : 'No field changed'}</p>
      ) : null}
      {undeclaredFields > 0 ? (
        <p>
          {undeclaredFields} {undeclaredFields === 1 ? 'field' : 'fields'} no longer in the model
        </p>
      ) : null}
      {change.others > 0 ? (
        <p>
          With {change.truncated ? 'more than ' : ''}
          {change.others} other {change.others === 1 ? 'entry' : 'entries'}
        </p>
      ) : null}
      {change.truncated ? <p>Other changes not listed</p> : null}
    </div>
  );
}

function ActivityItem(props: {
  row: AuditEntry;
  entryId: string;
  contentType?: ContentType;
  directory?: ActorDirectory;
}) {
  const { row, entryId } = props;
  const { words, viaMcp } = activityAction(row, entryId);
  return (
    // Focusable, so Load more can hand the keyboard on to the first row it brought, read whole:
    // what, who and when. The ring is the buttons' own, as focus must always show.
    <li
      tabIndex={-1}
      data-activity-row=""
      className="space-y-1 rounded-sm border-t py-2.5 outline-none first:border-t-0 first:pt-0 last:pb-0 focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      <p className="font-medium text-sm">
        {words ?? <span className="break-all font-mono font-normal text-xs">{row.action}</span>}
      </p>
      <p className="break-words text-muted-foreground text-xs">
        {actorLabel(row.actor, props.directory)}
        {viaMcp ? ' · through MCP' : ''}
        {' · '}
        <Ago at={row.at} />
      </p>
      <Changes change={activityChange(row, entryId)} contentType={props.contentType} />
    </li>
  );
}

/**
 * The editor's Activity view: who did what to this entry and when, newest first, with the fields
 * and locales each save changed. It is the audit log read for one entry (the rows that target it
 * and the ones that saved it while acting on something else, an approved agent proposal or a
 * duplicate), so it takes what the audit log takes: space:admin, which is why the editor only
 * offers it to an administrator. A page at a time from the foot, as every cursor-paged list.
 */
export function EntryActivity(props: {
  entryId: string;
  contentType?: ContentType;
  directory?: ActorDirectory;
}) {
  const { entryId } = props;
  const invalidate = useInvalidate();
  const pages = useEntryActivityPagesQuery(entryId);
  const rows = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const loading = pages.isPending;
  const failed = pages.isError && !pages.data;
  const fetchingMore = pages.isFetchingNextPage;
  const moreToRead = pages.hasNextPage;

  // Load more hands focus to the first row it brought; to the last if it brought none.
  const listRef = useRef<HTMLOListElement>(null);
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || fetchingMore) return;
    focusFrom.current = null;
    const items = listRef.current?.querySelectorAll<HTMLElement>('[data-activity-row]');
    (items?.[from] ?? (moreToRead ? undefined : items?.[items.length - 1]))?.focus();
  }, [fetchingMore, moreToRead]);

  return (
    <Card size="sm">
      <CardHeader>
        <h2 className="section-title">Activity</h2>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={pages.isFetching}
            onClick={() => void invalidate(['audit-log', 'entry', entryId])}
          >
            Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {failed ? (
          <Alert variant="destructive">
            <AlertTitle>The activity didn’t load</AlertTitle>
            <AlertDescription>
              <p>{apiErrorMessage(pages.error)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void pages.refetch()}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : loading ? (
          <ol aria-hidden="true">
            {['60%', '45%', '70%'].map((w) => (
              <li key={w} className="space-y-1.5 border-t py-2.5 first:border-t-0 first:pt-0">
                <span className="block text-sm">
                  <SkeletonText width="5rem" />
                </span>
                <span className="block text-xs">
                  <SkeletonText width={w} />
                </span>
              </li>
            ))}
          </ol>
        ) : rows.length === 0 ? (
          <Empty className="p-2">No activity recorded for this entry yet.</Empty>
        ) : (
          <Refreshing busy={pages.isFetching && !fetchingMore}>
            <ol ref={listRef} aria-label="Activity, newest first">
              {rows.map((row) => (
                <ActivityItem
                  key={row.id}
                  row={row}
                  entryId={entryId}
                  contentType={props.contentType}
                  directory={props.directory}
                />
              ))}
            </ol>
          </Refreshing>
        )}
        {moreToRead && !loading && !failed ? (
          <div className="border-t pt-2 text-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={fetchingMore}
              onClick={() => {
                focusFrom.current = rows.length;
                void pages.fetchNextPage();
              }}
            >
              {fetchingMore ? 'Loading more…' : 'Load more'}
            </Button>
          </div>
        ) : null}
        {/* A failed next page or refresh keeps the rows already read, and says so beside them. */}
        {pages.isFetchNextPageError || (pages.isRefetchError && !failed) ? (
          <p role="alert" className="text-destructive text-xs">
            {pages.isFetchNextPageError
              ? 'More activity didn’t load.'
              : 'The activity didn’t refresh; these rows may be out of date.'}{' '}
            {apiErrorMessage(pages.error)}
          </p>
        ) : null}
        <LoadingStatus>
          {loading
            ? 'Loading the entry’s activity…'
            : failed
              ? ''
              : `${rows.length}${moreToRead ? '+' : ''} ${rows.length === 1 && !moreToRead ? 'activity row' : 'activity rows'} shown`}
        </LoadingStatus>
      </CardContent>
    </Card>
  );
}
