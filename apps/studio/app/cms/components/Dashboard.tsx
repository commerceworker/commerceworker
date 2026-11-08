import { Button } from '@commerceworker/ui/button';
import { Input } from '@commerceworker/ui/input';
import { Skeleton } from '@commerceworker/ui/skeleton';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@commerceworker/ui/table';
import { SearchX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { entryPath, entryRef } from '~/cms/components/dashboard/entry-titles';
import { LiveActivityCard } from '~/cms/components/dashboard/LiveActivityCard';
import { ThroughputCard } from '~/cms/components/dashboard/ThroughputCard';
import { UsageByWorkflowCard } from '~/cms/components/dashboard/UsageByWorkflowCard';
import { UsageTrendCard } from '~/cms/components/dashboard/UsageTrendCard';
import { useEntriesById } from '~/cms/components/dashboard/use-entries-by-id';
import {
  AgentReviewCard,
  UnpublishedWorkCard,
  UpcomingCard,
} from '~/cms/components/dashboard/WorkCards';
import { Empty, PageHeader, Section } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { Mark } from '~/components/mark';
import { useClient } from '../lib/client-context';
import { humanize } from '../lib/format';
import type { SearchHit } from '../lib/management';
import {
  useAgentRunsQuery,
  useAllEntriesQuery,
  useContentTypesQuery,
  useScopedQuery,
} from '../lib/queries';
import { useToast } from '../lib/toast';

/** Unpublished entries fetched for the work card; the card says "N+" at the cap. */
const UNPUBLISHED_CAP = 50;
/** Agent runs that stopped for a human decision (agent-runtime's review states). */
const REVIEW_STATES = new Set(['needs_review', 'held']);

/**
 * The editor's start page: what needs attention first (unpublished work,
 * what's scheduled, agent proposals waiting on a decision), then search, then
 * AI usage as a quieter, clearly windowed section at the bottom.
 */
export function Dashboard() {
  const { client, conn } = useClient();
  const toast = useToast();
  const types = useContentTypesQuery().data ?? [];
  const runsQuery = useAgentRunsQuery();
  const runs = runsQuery.data ?? [];

  // Silent: each card shows its own inline failure instead of a toast storm
  // when a token lacks one of these scopes.
  const unpublishedQuery = useScopedQuery(
    // Under the 'entries' prefix so every entry mutation's invalidation refreshes it.
    ['entries', 'dashboard-unpublished'],
    () =>
      client.listEntries(undefined, {
        filters: [{ field: 'sys.status', op: 'in', value: ['draft', 'changed'] }],
        limit: UNPUBLISHED_CAP,
      }),
    { silent: true },
  );
  const scheduledQuery = useScopedQuery(
    ['scheduled-actions', 'pending'],
    () => client.listScheduledActions('pending'),
    { silent: true },
  );
  const releasesQuery = useScopedQuery(['releases'], () => client.listReleases(), {
    silent: true,
  });
  // Titles for the live activity feed (best-effort: the list is capped).
  const allEntries = useAllEntriesQuery().data;

  const unpublished = useMemo(
    () =>
      (unpublishedQuery.data ?? [])
        .map((e) => entryRef(e, types, conn.locale))
        // UUIDv7 ids sort by creation time: newest first.
        .sort((a, b) => (a.id < b.id ? 1 : -1)),
    [unpublishedQuery.data, types, conn.locale],
  );
  const refs = useMemo(() => {
    const map = new Map(
      (allEntries ?? []).map((e) => [e.id, entryRef(e, types, conn.locale)] as const),
    );
    for (const e of unpublished) map.set(e.id, e);
    return map;
  }, [allEntries, unpublished, types, conn.locale]);
  const scheduled = useMemo(
    () =>
      scheduledQuery.data
        ? [...scheduledQuery.data].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
        : undefined,
    [scheduledQuery.data],
  );
  const openReleases = useMemo(
    () => releasesQuery.data?.filter((r) => r.status === 'open'),
    [releasesQuery.data],
  );
  const awaitingReview = useMemo(() => runs.filter((r) => REVIEW_STATES.has(r.status)), [runs]);

  // Every entry a card names by id is resolved by id, in one batched lookup: the capped list
  // above can't be trusted to hold them, and an id is never a name.
  const namedIds = useMemo(
    () => [
      ...runs.map((r) => r.entryId),
      ...(scheduled ?? []).filter((a) => a.entityType === 'Entry').map((a) => a.entityId),
    ],
    [runs, scheduled],
  );
  const named = useEntriesById(namedIds);
  const entryById = (id: string) => named.refs.get(id) ?? refs.get(id);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const hitIds = useMemo(() => hits.map((h) => h.entryId), [hits]);
  const hitEntries = useEntriesById(hitIds);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      setHits(await client.search(query));
      setSearched(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        subtitle={`What needs attention in ${conn.space} / ${conn.environment}.`}
      />

      <section aria-label="Needs attention" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UnpublishedWorkCard
          entries={{
            data: unpublishedQuery.data ? unpublished : undefined,
            isLoading: unpublishedQuery.isLoading,
            isError: unpublishedQuery.isError,
          }}
          cap={UNPUBLISHED_CAP}
        />
        <UpcomingCard
          scheduled={{
            data: scheduled,
            isLoading: scheduledQuery.isLoading || named.isLoading,
            isError: scheduledQuery.isError,
          }}
          releases={{
            data: openReleases,
            isLoading: releasesQuery.isLoading,
            isError: releasesQuery.isError,
          }}
          entryById={entryById}
        />
        <AgentReviewCard
          runs={{
            data: runsQuery.data ? awaitingReview : undefined,
            isLoading: runsQuery.isLoading || named.isLoading,
            isError: runsQuery.isError,
          }}
          entryById={entryById}
        />
        <LiveActivityCard entryById={entryById} />
      </section>

      <Section
        title="Search published content"
        description="Finds published entries by meaning, not only by their words."
      >
        <form className="flex items-center gap-2" onSubmit={runSearch}>
          <Input
            aria-label="Search published content"
            type="search"
            enterKeyHint="search"
            autoCorrect="off"
            placeholder="Describe what you’re looking for…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </Button>
        </form>
        {hits.length > 0 && (
          <ul className="divide-y divide-border">
            {hits.map((h) => {
              const ref = hitEntries.refs.get(h.entryId) ?? refs.get(h.entryId);
              return (
                <li key={h.entryId} className="flex min-w-0 items-start gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    {ref ? (
                      <Link
                        to={entryPath(ref)}
                        className="block truncate font-medium text-sm underline-offset-2 hover:underline"
                      >
                        {ref.title}
                      </Link>
                    ) : hitEntries.isLoading ? (
                      <Skeleton className="h-5 w-1/2" aria-hidden />
                    ) : (
                      // Published, but its draft is gone or hidden from this principal.
                      <span className="block truncate font-medium text-muted-foreground text-sm">
                        Entry no longer available
                      </span>
                    )}
                    <p className="line-clamp-2 text-muted-foreground text-xs">{h.snippet}</p>
                  </div>
                  <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                    {Math.round(h.score * 100)}% match
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {searched && hits.length === 0 && (
          <Empty icon={<SearchX />} title="No matches">
            No published content matched that query. Try different wording.
          </Empty>
        )}
      </Section>

      <section aria-labelledby="dash-ai-usage" className="space-y-4 pt-2">
        <div>
          <h2 id="dash-ai-usage" className="section-title">
            AI usage
          </h2>
          <p className="max-w-measure text-muted-foreground text-sm">
            Tokens spent by agent runs. Each card states its time window.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <UsageTrendCard runs={runs} />
          <ThroughputCard runs={runs} />
          <UsageByWorkflowCard runs={runs} />
        </div>

        <Section id="agent-runs" title="Recent agent runs" flush={runs.length > 0}>
          {runs.length === 0 ? (
            <Empty icon={<Mark className="text-ai" />} title="No agent runs yet">
              Enable AGENTS_ENRICH on the worker and runs will appear here as content is published.
            </Empty>
          ) : (
            <Table stack="cards" caption="Recent agent runs">
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead numeric>Tokens (in/out)</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => {
                  const ref = r.entryId ? entryById(r.entryId) : undefined;
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{humanize(r.workflow)}</TableCell>
                      <TableCell label="Entry" className="max-w-56 truncate text-muted-foreground">
                        {ref ? (
                          <Link to={entryPath(ref)} className="underline-offset-2 hover:underline">
                            {ref.title}
                          </Link>
                        ) : r.entryId ? (
                          named.isLoading ? (
                            <Skeleton className="h-4 w-24" aria-hidden />
                          ) : (
                            'Entry no longer available'
                          )
                        ) : (
                          // A space-level run (curate, a digest) acts on no one entry.
                          '—'
                        )}
                      </TableCell>
                      <TableCell label="Status">
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell label="Tokens" numeric className="text-muted-foreground">
                        {r.inputTokens}/{r.outputTokens}
                      </TableCell>
                      <TableCell label="When" className="text-muted-foreground">
                        <Ago at={r.createdAt} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Section>
      </section>
    </div>
  );
}
