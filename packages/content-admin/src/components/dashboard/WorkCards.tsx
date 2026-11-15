import { StatusBadge } from '@commerceworker/content-admin/components/status';
import { Link } from '@commerceworker/content-admin/router';
import type { Release, ScheduledAction } from '@commerceworker/domain';
import { Card, CardContent, CardHeader, CardTitle } from '@commerceworker/ui/card';
import { Skeleton } from '@commerceworker/ui/skeleton';
import type { ReactNode } from 'react';
import { humanize } from '../../lib/format';
import type { AgentRun } from '../../lib/management';
import { type EntryRef, entryPath, shortDateTime } from './entry-titles';

/** How many rows a work card shows before pointing elsewhere for the rest. */
export const WORK_ROWS = 8;

/** Async slice a work card renders: loading, failed, or loaded. */
export interface Loadable<T> {
  readonly data: T | undefined;
  readonly isLoading: boolean;
  readonly isError: boolean;
}

function WorkCard(props: {
  title: string;
  count?: ReactNode;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-baseline justify-between gap-2">
          <h2 className="font-heading font-medium text-base">{props.title}</h2>
          {props.count !== undefined && (
            <span className="text-muted-foreground text-xs tabular-nums">{props.count}</span>
          )}
        </CardTitle>
        <p className="text-muted-foreground text-sm">{props.description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.children}
        {props.footer}
      </CardContent>
    </Card>
  );
}

function Rows<T>(props: {
  slice: Loadable<readonly T[]>;
  empty: string;
  error: string;
  limit?: number;
  render: (item: T) => ReactNode;
}) {
  const { slice } = props;
  if (slice.isLoading) {
    return (
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
      </div>
    );
  }
  if (slice.isError) return <p className="text-muted-foreground text-sm">{props.error}</p>;
  const items = slice.data ?? [];
  if (items.length === 0) return <p className="text-muted-foreground text-sm">{props.empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {items.slice(0, props.limit ?? WORK_ROWS).map(props.render)}
    </ul>
  );
}

/** One row: a linked title that truncates, a muted secondary line, a trailing badge/time. */
function Row(props: { to?: string; title: string; meta: ReactNode; trailing?: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-3 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        {props.to ? (
          <Link
            to={props.to}
            className="block truncate font-medium text-sm underline-offset-2 hover:underline"
            title={props.title}
          >
            {props.title}
          </Link>
        ) : (
          <span className="block truncate font-medium text-sm" title={props.title}>
            {props.title}
          </span>
        )}
        <p className="truncate text-muted-foreground text-xs">{props.meta}</p>
      </div>
      {props.trailing && <div className="shrink-0">{props.trailing}</div>}
    </li>
  );
}

const countLabel = (n: number, cap: number) => (n >= cap ? `${cap}+` : String(n));

/** Drafts and published entries with unpublished edits, newest first. */
export function UnpublishedWorkCard(props: {
  entries: Loadable<readonly EntryRef[]>;
  cap: number;
}) {
  const n = props.entries.data?.length ?? 0;
  return (
    <WorkCard
      title="Not yet published"
      count={props.entries.data ? countLabel(n, props.cap) : undefined}
      description="Drafts and entries with changes that aren’t live. Newest entries first."
      footer={
        n > WORK_ROWS && (
          <p className="text-muted-foreground text-xs">
            Showing {WORK_ROWS} of {countLabel(n, props.cap)}. Filter by status in each content list
            for the rest.
          </p>
        )
      }
    >
      <Rows
        slice={props.entries}
        empty="Everything is published. Nothing waiting on you."
        error="Couldn’t load unpublished entries."
        render={(e) => (
          <Row
            key={e.id}
            to={entryPath(e)}
            title={e.title}
            meta={e.typeName}
            trailing={<StatusBadge status={e.status} />}
          />
        )}
      />
    </WorkCard>
  );
}

/** Pending scheduled actions (soonest first) and releases still open. */
export function UpcomingCard(props: {
  scheduled: Loadable<readonly ScheduledAction[]>;
  releases: Loadable<readonly Release[]>;
  /** Resolves a scheduled entry to a linkable title, when known. */
  entryById: (id: string) => EntryRef | undefined;
}) {
  const releaseTitle = (id: string) =>
    props.releases.data?.find((r) => r.id === id)?.title ?? 'Release no longer open';
  return (
    <WorkCard
      title="Coming up"
      description="Scheduled publishes and releases that haven’t shipped."
    >
      <div className="space-y-2">
        <h3 className="font-medium text-muted-foreground text-xs">Scheduled</h3>
        <Rows
          slice={props.scheduled}
          limit={5}
          empty="Nothing scheduled."
          error="Couldn’t load scheduled actions."
          render={(a) => {
            const entry = a.entityType === 'Entry' ? props.entryById(a.entityId) : undefined;
            const verb = a.action === 'publish' ? 'Publish' : 'Unpublish';
            return (
              <Row
                key={a.id}
                to={entry ? entryPath(entry) : a.entityType === 'Release' ? '/releases' : undefined}
                title={
                  a.entityType === 'Release'
                    ? releaseTitle(a.entityId)
                    : (entry?.title ?? 'Entry no longer available')
                }
                meta={`${verb} ${a.entityType === 'Release' ? 'release' : (entry?.typeName ?? 'entry')}`}
                trailing={
                  <time
                    dateTime={a.scheduledFor}
                    className="text-muted-foreground text-xs tabular-nums"
                  >
                    {shortDateTime(a.scheduledFor)}
                  </time>
                }
              />
            );
          }}
        />
      </div>
      <div className="space-y-2 border-border border-t pt-3">
        <h3 className="font-medium text-muted-foreground text-xs">Open releases</h3>
        <Rows
          slice={props.releases}
          limit={5}
          empty="No open releases."
          error="Couldn’t load releases."
          render={(r) => (
            <Row
              key={r.id}
              to="/releases"
              title={r.title}
              meta={`Opened ${shortDateTime(r.createdAt)}`}
            />
          )}
        />
      </div>
    </WorkCard>
  );
}

/** Agent runs that stopped for a human: proposals to review, content moderation held. */
export function AgentReviewCard(props: {
  runs: Loadable<readonly AgentRun[]>;
  entryById: (id: string) => EntryRef | undefined;
}) {
  const n = props.runs.data?.length;
  return (
    <WorkCard
      title="Agent proposals awaiting review"
      count={n}
      description="Agent output is never applied silently. These runs stopped for a decision."
      footer={
        n ? (
          <Link to="/approvals" className="text-link text-sm underline-offset-2 hover:underline">
            Review in Approvals
          </Link>
        ) : null
      }
    >
      <Rows
        slice={props.runs}
        empty="No agent proposals waiting."
        error="Couldn’t load agent runs."
        render={(r) => {
          const entry = r.entryId ? props.entryById(r.entryId) : undefined;
          const meta = [humanize(r.workflow), r.decisions[0], shortDateTime(r.createdAt)]
            .filter(Boolean)
            .join(' · ');
          return (
            <Row
              key={r.id}
              to={entry ? entryPath(entry) : undefined}
              // A space-level run (no entry) is named by its decision instead. An entry the lookup
              // couldn't find was deleted or is hidden: say so rather than show its id.
              title={
                entry?.title ??
                (r.entryId ? 'Entry no longer available' : (r.decisions[0] ?? humanize(r.workflow)))
              }
              meta={entry ? `${entry.typeName} · ${meta}` : meta}
              trailing={<StatusBadge status={r.status} />}
            />
          );
        }}
      />
    </WorkCard>
  );
}
