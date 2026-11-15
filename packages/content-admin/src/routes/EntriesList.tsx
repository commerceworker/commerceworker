import { BulkJobProgress } from '@commerceworker/content-admin/components/bulk-job-progress';
import { EntryFilterBar } from '@commerceworker/content-admin/components/EntryFilterBar';
import { InlineConfirm } from '@commerceworker/content-admin/components/InlineConfirm';
import {
  LoadingStatus,
  PageSkeleton,
  Refreshing,
  rememberCount,
  rememberedCount,
} from '@commerceworker/content-admin/components/loading';
import { Empty, EmptyState, PageHeader } from '@commerceworker/content-admin/components/page';
import { ResponsiveSheetContent } from '@commerceworker/content-admin/components/responsive-sheet';
import { useNavigate, useParams, useSearchParams } from '@commerceworker/content-admin/router';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@commerceworker/ui/alert-dialog';
import { Button } from '@commerceworker/ui/button';
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from '@commerceworker/ui/sheet';
import { SkeletonText } from '@commerceworker/ui/skeleton';
import { type InfiniteData, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ColumnPicker } from '../components/entries/ColumnPicker';
import {
  EntriesTable,
  type EntryRowActions,
  needsPublish,
  SORT_UPDATED,
} from '../components/entries/EntriesTable';
import { EntryBulkBar } from '../components/entries/EntryBulkBar';
import { EntryDiff } from '../components/entries/EntryReview';
import { PublishConfirm } from '../components/entries/PublishConfirm';
import { SavedViewsMenu } from '../components/entries/SavedViewsMenu';
import { orDirect, useAssistantEdit, usePageContext } from '../lib/assistant';
import { bulkSummary, jobFailures, jobOutcome } from '../lib/bulk-jobs';
import { useClient } from '../lib/client-context';
import {
  CONNECTION_PARAMS,
  type EntryListState,
  listStateFromParams,
  listStateToParams,
} from '../lib/entry-url';
import { plural } from '../lib/format';
import {
  ApiError,
  apiErrorMessage,
  type BulkJobSummary,
  type EntryAggregate,
  type EntryListQuery,
  type EntryOrder,
  type EntryPage,
  type PreviewEntry,
} from '../lib/management';
import {
  useDebouncedValue,
  useEntryPagesQuery,
  useQueryKeys,
  useScopedQuery,
} from '../lib/queries';
import { type ToastOptions, useToast } from '../lib/toast';
import { useContentOutlet } from './content-context';

type BulkSummary = Awaited<ReturnType<ReturnType<typeof useClient>['client']['bulkEntryAction']>>;

/**
 * The order a column header asks for. Title and Status go ascending first, then flip. Updated
 * flips between newest first and the list's default (least recently changed first), which is no
 * order at all: the plain list, walked in SQL.
 */
export function nextOrder(current: EntryOrder | undefined, field: string): EntryOrder | undefined {
  if (field === SORT_UPDATED) {
    return current?.field === SORT_UPDATED && current.direction === 'desc'
      ? undefined
      : { field, direction: 'desc' };
  }
  if (current?.field === field)
    return { field, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  return { field, direction: 'asc' };
}

/** A live entry: published as it is, or changed since. */
const isLive = (status: string) => status === 'published' || status === 'changed';

/** Why a role can't start the trash, restore and delete jobs, said in the bulk bar. */
const JOBS_REFUSAL =
  'Moving many entries to the trash, restoring or deleting them runs as a background job, which ' +
  'takes a role allowed to do that to every content type. Use each entry’s own menu instead, or ' +
  'ask a space administrator.';

/** How many titles a bulk confirm names before counting the rest. */
const NAMED = 5;

/** How often a running bulk job is asked how far it has got (as the asset library's are). */
const BULK_JOB_POLL_MS = 2000;

/** What the trash's bulk actions run as a job on the server: the list's, and the trash's two. */
type TrashJobAction = 'trash' | 'restore' | 'purge';

/** A trash job's words, done and under way, for its card and toasts ("Trashed 3 entries"). */
const JOB_VERBS: Record<TrashJobAction, { readonly done: string; readonly doing: string }> = {
  trash: { done: 'Trashed', doing: 'Trashing' },
  restore: { done: 'Restored', doing: 'Restoring' },
  purge: { done: 'Permanently deleted', doing: 'Permanently deleting' },
};

/**
 * What a bulk confirm asks about. Publish and purge can't be undone, so they ask in a modal;
 * Unpublish (its toast has Undo) and the trash (its entries can be restored) ask in place.
 */
type BulkConfirm = 'publish' | 'unpublish' | 'trash' | 'purge';

/** Each confirm's question, what it says will happen, and its button. */
const CONFIRM_COPY: Record<
  BulkConfirm,
  {
    /** The question, given how many: "Publish 3 entries?". */
    readonly title: (count: string) => string;
    readonly says: string;
    readonly button: string;
    readonly keep: string;
  }
> = {
  publish: {
    title: (n) => `Publish ${n}?`,
    says: 'The current draft of each selected entry goes live on the delivery API.',
    button: 'Publish entries',
    keep: 'Keep as is',
  },
  unpublish: {
    title: (n) => `Unpublish ${n}?`,
    says: 'Each selected entry is removed from the delivery API and returns to draft.',
    button: 'Unpublish entries',
    keep: 'Keep as is',
  },
  trash: {
    title: (n) => `Move ${n} to the trash?`,
    says:
      'Live entries are unpublished first, so the delivery API stops serving them. ' +
      'You can restore any of them from the trash.',
    button: 'Move to trash',
    keep: 'Keep as is',
  },
  purge: {
    title: (n) => `Permanently delete ${n}?`,
    says:
      'This deletes each selected entry and its entire version history. It can’t be undone. ' +
      'An entry other published entries link to is kept, so their links don’t break.',
    button: 'Delete permanently',
    keep: 'Keep in trash',
  },
};

/**
 * Entries table for one content type, with bulk publishing, the trash and a draft/published diff.
 *
 * Its edits go through the assistant (`useAssistantEdit`): publishing, unpublishing, the trash,
 * deleting for good and bulk changes (bulk publishing, and moving to the trash or deleting for
 * good as a job) stop at a confirm card in its panel, and run once confirmed; duplicating and
 * restoring from the trash run at once and leave a line. When the assistant can't be reached,
 * each goes straight to the API as before (bulk changes and deleting for good confirm in the
 * page's own dialogs). Restoring several from the trash always goes straight to the API, as a job,
 * with no confirm. Undo in a toast always goes straight to the API.
 */
export function EntriesList() {
  const { typeId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { client, conn, busy, run } = useClient();
  const { types, typesPending } = useContentOutlet();
  const queryClient = useQueryClient();
  const keys = useQueryKeys();
  const edit = useAssistantEdit();

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [diffEntry, setDiffEntry] = useState<PreviewEntry | null>(null);
  // Permanent deletion is the one entry action with no way back, so it is
  // always confirmed by name.
  const [confirmPurge, setConfirmPurge] = useState<PreviewEntry | null>(null);
  // A row's Publish of an entry that has been live, awaiting the same confirmation (and diff of
  // what changes) as the editor's Publish.
  const [confirmPublish, setConfirmPublish] = useState<PreviewEntry | null>(null);
  const publishedRow = useRef<string | null>(null);
  // What the confirm says as it leaves: `confirmPublish` is gone by then, the dialog not yet.
  const lastAskedPublish = useRef<PreviewEntry | null>(null);
  if (confirmPublish) lastAskedPublish.current = confirmPublish;
  const askedPublish = confirmPublish ?? lastAskedPublish.current;
  // Bulk action awaiting confirmation (bulk selections are tedious to rebuild,
  // so the whole batch is confirmed once before it runs).
  const [confirmBulk, setConfirmBulk] = useState<BulkConfirm | null>(null);
  const bulkBarRef = useRef<HTMLDivElement>(null);
  // A trash, restore or permanent delete of the ticked entries, running as a job on the server.
  const [entryJob, setEntryJob] = useState<{
    readonly action: TrashJobAction;
    readonly job: BulkJobSummary;
  } | null>(null);
  const [cancellingJob, setCancellingJob] = useState(false);
  // Per-item failures from the last bulk action, with resolved titles so the
  // editor knows WHICH entries failed, not just how many.
  const [bulkFailures, setBulkFailures] = useState<
    { id: string; title: string; error?: string }[] | null
  >(null);
  // How many a finished job failed when its report couldn't be read, so they can't be named, and
  // why it couldn't.
  const [unnamedFailures, setUnnamedFailures] = useState<{
    readonly count: number;
    readonly reason: string;
  } | null>(null);
  // The list's filters, search, sort, columns and open saved view are its URL, so a link and a
  // view agree and Back undoes a view picked. The URL belongs to this type's page: another type is
  // another path, with none of this one's filters (which name this type's fields).
  const [searchParams, setSearchParams] = useSearchParams();
  const listState = useMemo(() => listStateFromParams(searchParams), [searchParams]);
  const filterState = useMemo(() => ({ typeId, query: listState.query }), [typeId, listState]);
  const setListState = (next: EntryListState, opts: { push?: boolean } = {}) => {
    const params = listStateToParams(next);
    // The connection's own parameters stay where they are.
    for (const key of CONNECTION_PARAMS) {
      const value = searchParams.get(key);
      if (value !== null) params.set(key, value);
    }
    setSearchParams(params, { replace: !opts.push });
  };
  // What is ticked, open or being confirmed is per type: reset in-render when the type changes.
  const [shownType, setShownType] = useState(typeId);
  if (shownType !== typeId) {
    setShownType(typeId);
    setPicked(new Set());
    setDiffEntry(null);
    setConfirmPurge(null);
    setConfirmPublish(null);
    setConfirmBulk(null);
    setBulkFailures(null);
    setUnnamedFailures(null);
    // A running job is kept: it goes on on the server whatever is open, and its card (and the
    // reload when it ends) still say what it did. Only what is ticked is per type.
  }
  const query = listState.query;
  const setQuery = (q: EntryListQuery) => setListState({ ...listState, query: q });

  const selectedType = types.find((t) => t.apiId === typeId);
  usePageContext(
    () => ({ kind: 'content-type', contentType: typeId ?? '', label: selectedType?.name ?? '' }),
    [typeId, selectedType?.name],
  );

  // The list is keyed by type + debounced filters; edits to the filter bar
  // re-key the query after 250ms while the previous page stays visible.
  const debounced = useDebouncedValue(filterState, 250);
  const debouncedQuery = debounced.typeId === typeId ? debounced.query : {};
  // The list reads a page at a time and Load more walks on with the last page's cursor. Another
  // type, filter, search or sort is another key: it starts again from the first page.
  const listKey = JSON.stringify([typeId, debouncedQuery]);
  const entriesQuery = useEntryPagesQuery(typeId, debouncedQuery);
  const pagesData = entriesQuery.data;
  const entries = useMemo(() => dedupe(pagesData?.pages), [pagesData]);
  const loading = entriesQuery.isPending;
  const entriesKey = keys.entryPages(typeId, debouncedQuery);
  const hasMore = !loading && entriesQuery.hasNextPage;
  // The type's real total, for the header (the list itself holds only what has been read). Under
  // the entries prefix, so entry mutations refresh it; silent, as the header works without it.
  const countsQuery = useScopedQuery(['entries', 'counts'], () => client.contentTypeEntryCounts(), {
    silent: true,
  });
  // The skeleton comes back as long as this list was last time (this session).
  const countKey = `entries:${typeId ?? 'all'}`;
  useEffect(() => {
    if (entriesQuery.data && !entriesQuery.isPlaceholderData)
      rememberCount(countKey, dedupe(entriesQuery.data.pages).length);
  }, [countKey, entriesQuery.data, entriesQuery.isPlaceholderData]);

  // A new filter, search or sort leaves ticked only what it still shows: a selection the reader
  // can't see would be published with the rest. Load more and refetches keep it whole.
  const prunedFor = useRef(listKey);
  useEffect(() => {
    if (!entriesQuery.data || entriesQuery.isPlaceholderData || prunedFor.current === listKey)
      return;
    prunedFor.current = listKey;
    const shown = new Set(dedupe(entriesQuery.data.pages).map((e) => e.id));
    setPicked((prev) => {
      const next = new Set([...prev].filter((id) => shown.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [listKey, entriesQuery.data, entriesQuery.isPlaceholderData]);

  // Polls a running trash job, and stops once it has finished.
  const runningJob = entryJob?.job.status === 'running' ? entryJob.job.id : null;
  useEffect(() => {
    if (!runningJob) return;
    const timer = setInterval(() => {
      client
        .getBulkJob(runningJob)
        // Never backwards: a poll that left before a Stop came back must not undo the stop.
        .then((job) =>
          setEntryJob((current) =>
            current?.job.id === job.id && current.job.status === 'running'
              ? { ...current, job }
              : current,
          ),
        )
        .catch((e) => {
          // A refusal won't pass by itself: stop watching and free the bar. Anything else is
          // transient, and the next tick tries again.
          if (!(e instanceof ApiError) || e.status < 400 || e.status >= 500) return;
          setEntryJob(null);
          toast.error(
            `Stopped following the bulk job: ${apiErrorMessage(e)}. It goes on running; reload to see what it did.`,
          );
        });
    }, BULK_JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [runningJob, client]);
  // Asked in place, the list stays usable: clearing the ticks answers the question.
  useEffect(() => {
    if (picked.size === 0) setConfirmBulk(null);
  }, [picked.size]);
  // Once it has finished: say so, reload the list, and keep what failed ticked, named from the
  // job's report. Once per finished job (polling stops, so the object no longer changes).
  const finishedJob = entryJob && entryJob.job.status !== 'running' ? entryJob : null;
  useEffect(() => {
    if (!finishedJob) return;
    const { action, job } = finishedJob;
    const said = bulkSummary(JOB_VERBS[action].done, jobOutcome(job), ['entry', 'entries']);
    (job.failed ? toast.error : toast.success)(
      job.status === 'cancelled' ? `Stopped: ${said}` : said,
    );
    // A stopped job left some entries as they were: the selection stays, to run it again.
    if (job.failed === 0 && job.status !== 'cancelled') setPicked(new Set());
    // Read before the list reloads: what succeeded leaves this view.
    const titles = new Map(entries.map((e) => [e.id, titleOf(e.id)]));
    // Ticked is only ever what the reloaded list shows: what the job moved out of this view (or
    // a job started on another type's list) is never left ticked unseen.
    const listed = () =>
      new Set(
        dedupe(queryClient.getQueryData<InfiniteData<EntryPage>>(entriesKey)?.pages).map(
          (e) => e.id,
        ),
      );
    const keepListed = (ids?: readonly string[]) => {
      const shown = listed();
      setPicked((prev) => {
        const next = new Set([...(ids ?? prev)].filter((id) => shown.has(id)));
        return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
      });
    };
    const reloaded = Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.entriesRoot }),
      queryClient.invalidateQueries({ queryKey: keys.entryRoot }),
    ]);
    if (job.failed === 0) {
      void reloaded.then(() => keepListed());
      return;
    }
    Promise.all([client.getBulkJobReport(job.id), reloaded])
      .then(([report]) => {
        const failures = jobFailures(report, titles);
        keepListed(failures.map((f) => f.id));
        setBulkFailures(
          failures.map((f) => ({
            id: f.id,
            title: titles.get(f.id) ?? 'Untitled entry',
            error: f.error,
          })),
        );
      })
      .catch(async (e) => {
        // Without the report the failures can't be named: say how many, and leave ticked what is
        // still listed, which is what the job didn't move.
        await reloaded.catch(() => {});
        keepListed();
        setUnnamedFailures({ count: job.failed, reason: apiErrorMessage(e) });
      });
  }, [finishedJob]);

  const pick = (ids: readonly string[], value: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (value) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  // Optimistically reflect a status change in the cached pages; roll back on failure.
  const optimisticStatus = (ids: Set<string>, status: string) =>
    queryClient.setQueryData<InfiniteData<EntryPage>>(entriesKey, (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((p) => ({
              ...p,
              items: p.items.map((e) => (ids.has(e.id) ? { ...e, status } : e)),
            })),
          }
        : data,
    );
  const snapshotPages = () => queryClient.getQueryData<InfiniteData<EntryPage>>(entriesKey);

  const refreshEntries = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.entriesRoot }),
      // Publish/unpublish change an entry's status/version, which the editor's
      // detail query also holds.
      queryClient.invalidateQueries({ queryKey: keys.entryRoot }),
    ]);

  // Shared mutation shell: cancel in-flight list refetches so they can't stomp
  // the optimistic write, skip the optimistic write entirely while the table
  // shows placeholder rows from another key, and always revalidate — success
  // or failure — so the cache never keeps a rolled-back or half-applied list.
  const mutateEntries = (act: () => Promise<void>) =>
    run(async () => {
      await queryClient.cancelQueries({ queryKey: keys.entriesRoot });
      try {
        await act();
      } finally {
        await refreshEntries();
      }
    });

  const viewingTrash = query.trashed === true;
  const setViewingTrash = (trashed: boolean) => {
    setPicked(new Set());
    setDiffEntry(null);
    setQuery({ ...query, trashed: trashed || undefined });
  };

  // Trashing a live entry also unpublishes it (server-side, one transaction),
  // so Undo restores it and, only when the live version was exactly the
  // current draft, republishes it. A "changed" entry's old live version is
  // gone, and republishing would ship the unreviewed draft, so it comes back
  // as a draft and the toast says so.
  const trash = (e: PreviewEntry) =>
    mutateEntries(async () => {
      const title = titleOf(e.id);
      const r = await orDirect(await edit('entries_trash', { id: e.id }, title), () =>
        client.trashEntry(e.id),
      );
      if (!('output' in r)) return;
      toast.success(
        e.status === 'draft'
          ? `“${title}” moved to the trash`
          : `“${title}” unpublished and moved to the trash`,
        { action: { label: 'Undo', onAction: () => void undoTrash(e, title) } },
      );
    });
  const undoTrash = (e: PreviewEntry, title: string) =>
    mutateEntries(async () => {
      await client.restoreEntry(e.id);
      if (e.status === 'published') {
        await client.publishEntry(e.id);
        toast.success(`“${title}” restored and live again`);
      } else if (e.status === 'changed') {
        toast.success(`“${title}” restored as a draft; publish it to put it back live`);
      } else {
        toast.success(`“${title}” restored`);
      }
    });
  // Undo for an unpublish is a republish, which is a true inverse only for an
  // entry whose draft matched the live version (status "published").
  const undoUnpublish = (ids: readonly string[], label: string) =>
    mutateEntries(async () => {
      if (ids.length === 1) {
        await client.publishEntry(ids[0] ?? '');
      } else {
        const r = await client.bulkEntryAction('publish', [...ids]);
        if (r.failed > 0) {
          toast.error(`Republished ${r.succeeded}; ${r.failed} failed`);
          return;
        }
      }
      toast.success(label);
    });
  const restore = (e: PreviewEntry) =>
    mutateEntries(async () => {
      const r = await orDirect(await edit('entries_restore', { id: e.id }, titleOf(e.id)), () =>
        client.restoreEntry(e.id),
      );
      if (!('output' in r)) return;
      toast.success(`“${titleOf(e.id)}” restored as a draft`);
    });
  // Deleting for good: the assistant's card, or (without it) the page's dialog naming the entry.
  const requestPurge = (e: PreviewEntry) =>
    mutateEntries(async () => {
      const r = await edit('entries_purge', { id: e.id }, titleOf(e.id));
      if (r === null) setConfirmPurge(e);
      else if ('output' in r) toast.success('Entry permanently deleted');
    });
  const purge = (e: PreviewEntry) =>
    mutateEntries(async () => {
      await client.purgeEntry(e.id);
      toast.success('Entry permanently deleted');
    });
  const duplicate = (e: PreviewEntry) =>
    mutateEntries(async () => {
      const r = await orDirect(
        await edit<{ entry: EntryAggregate }>('entries_duplicate', { id: e.id }, titleOf(e.id)),
        () => client.duplicateEntry(e.id),
      );
      if (!('output' in r)) return;
      toast.success('Entry duplicated');
      navigate(`/content/${selectedType?.apiId}/${r.output.entry.id}`);
    });

  // What toasts, confirmations and the assistant's cards call an entry: never its id.
  const titleOf = (id: string) => {
    const entry = entries.find((e) => e.id === id);
    const value = selectedType
      ? (entry?.fields[selectedType.displayField] as Record<string, unknown> | undefined)?.[
          conn.locale
        ]
      : undefined;
    return typeof value === 'string' && value ? value : 'Untitled entry';
  };
  // Where telling entries apart matters (a delete that can't be undone, a list of failures), an
  // untitled one also shows its id, as a detail beside the name, never as the name.
  const idDetail = (id: string, title: string) =>
    title === 'Untitled entry' ? (
      <span className="ml-1.5 font-mono font-normal text-muted-foreground text-xs">{id}</span>
    ) : null;

  // One bulk API call handles the whole selection server-side, reporting
  // per-item outcomes; partial failures are surfaced by entry, not as a count.
  const bulk = (action: 'publish' | 'unpublish', verb: string, status: string) => {
    const ids = bulkIds(action);
    setPicked(new Set());
    setBulkFailures(null);
    return mutateEntries(async () => {
      const optimistic = !entriesQuery.isPlaceholderData;
      const snapshot = entries;
      const pages = snapshotPages();
      if (optimistic) optimisticStatus(new Set(ids), status);
      let summary: BulkSummary;
      try {
        summary = await client.bulkEntryAction(action, ids);
      } catch (e) {
        if (optimistic) queryClient.setQueryData(entriesKey, pages);
        // Nothing ran: the selection comes back as it was.
        setPicked(new Set(ids));
        throw e;
      }
      reportBulk(action, verb, summary, snapshot);
    });
  };

  // What a bulk action sends: the ticked entries it would change (Publish what isn't live as it
  // is, Unpublish what is live), so the rest aren't reported as failures.
  const statusOf = (id: string) => entries.find((e) => e.id === id)?.status ?? '';
  const bulkIds = (action: 'publish' | 'unpublish') =>
    [...picked].filter((id) =>
      action === 'publish' ? needsPublish(statusOf(id)) : isLive(statusOf(id)),
    );

  // A bulk change through the assistant's card. Without it, the page confirms the batch itself
  // (`confirmBulk`), and `bulk` runs it straight through the API.
  const requestBulk = (action: 'publish' | 'unpublish') => {
    const ids = bulkIds(action);
    const verb = action === 'publish' ? 'Published' : 'Unpublished';
    return mutateEntries(async () => {
      const snapshot = entries;
      const r = await edit<BulkSummary>(
        'entries_bulk_action',
        { action, ids },
        `${action === 'publish' ? 'Publish' : 'Unpublish'} ${ids.length} ${ids.length === 1 ? 'entry' : 'entries'}`,
      );
      if (r === null) {
        setConfirmBulk(action);
        return;
      }
      if (!('output' in r)) return;
      setBulkFailures(null);
      reportBulk(action, verb, r.output, snapshot);
    });
  };

  // The trash's bulk actions run as a job on the server over everything ticked, and this tab
  // watches it, as the asset library does. Moving to the trash and deleting for good stop at the
  // assistant's card (`bulk_job_start`), whose answer is the job, followed here as if this page
  // had started it; without the assistant, the page asks itself. Restoring runs at once,
  // straight through the API, as a row's Restore does. The bar waits while a job runs.
  const followJob = (action: TrashJobAction, job: BulkJobSummary) => {
    setBulkFailures(null);
    setUnnamedFailures(null);
    setEntryJob({ action, job });
  };
  const startJob = (action: TrashJobAction) => {
    const ids = [...picked];
    if (ids.length === 0) return;
    return run(async () => followJob(action, await client.startEntryBulkJob(action, ids)));
  };
  const requestJob = (action: 'trash' | 'purge') => {
    const ids = [...picked];
    if (ids.length === 0) return;
    const many = plural(ids.length, 'entry', 'entries');
    return run(async () => {
      const r = await edit<BulkJobSummary>(
        'bulk_job_start',
        { action, entryIds: ids },
        action === 'trash' ? `Move ${many} to the trash` : `Permanently delete ${many}`,
      );
      if (r === null) {
        setConfirmBulk(action);
        return;
      }
      if ('output' in r) followJob(action, r.output);
    });
  };
  const jobRunning = entryJob?.job.status === 'running';
  // Trash, restore and delete run as bulk jobs, which the api starts only for a role holding
  // their actions on every content type (`bulkJobs`, the api's own rule): each one this role
  // can't start is disabled and says why, rather than answering with a 403.
  const accessQuery = useScopedQuery(['space-access'], () => client.getSpaceAccess(), {
    silent: true,
  });
  const access = accessQuery.data;
  const deniedJobs = access
    ? (['trash', 'restore', 'purge'] as const).filter((job) => !access.bulkJobs?.includes(job))
    : [];
  const jobsPending = access === undefined && !accessQuery.isError;
  const cancelJob = async (id: string) => {
    setCancellingJob(true);
    try {
      const job = await client.cancelBulkJob(id);
      setEntryJob((current) => (current?.job.id === id ? { ...current, job } : current));
    } catch (e) {
      toast.error(`The job wasn’t stopped: ${apiErrorMessage(e)}`);
    } finally {
      setCancellingJob(false);
    }
  };

  // Partial failures are surfaced by entry, not as a count, and stay ticked so the editor can
  // try them again; an all-live unpublish offers Undo.
  const reportBulk = (
    action: 'publish' | 'unpublish',
    verb: string,
    summary: BulkSummary,
    snapshot: readonly PreviewEntry[],
  ) => {
    const failed = summary.results.filter((r) => !r.ok);
    setPicked(new Set(failed.map((r) => r.id)));
    if (summary.failed > 0) {
      setBulkFailures(failed.map((r) => ({ id: r.id, title: titleOf(r.id), error: r.error })));
      toast.error(`${verb} ${summary.succeeded}; ${summary.failed} failed (details in the list)`);
    } else {
      const done = summary.results.filter((r) => r.ok).map((r) => r.id);
      const wasLive = new Set(snapshot.filter((e) => e.status === 'published').map((e) => e.id));
      const undoable =
        action === 'unpublish' && done.length > 0 && done.every((id) => wasLive.has(id));
      toast.success(
        `${verb} ${summary.succeeded} ${summary.succeeded === 1 ? 'entry' : 'entries'}`,
        undoable
          ? {
              action: {
                label: 'Undo',
                onAction: () =>
                  void undoUnpublish(
                    done,
                    `Republished ${done.length} ${done.length === 1 ? 'entry' : 'entries'}`,
                  ),
              },
            }
          : undefined,
      );
    }
  };

  // Straight through the API: the status changes at once and rolls back on failure. Callers wrap
  // it in `mutateEntries`.
  const applyStatus = async <T,>(id: string, status: string, act: (id: string) => Promise<T>) => {
    const optimistic = !entriesQuery.isPlaceholderData;
    const pages = snapshotPages();
    if (optimistic) optimisticStatus(new Set([id]), status);
    try {
      return await act(id);
    } catch (e) {
      if (optimistic) queryClient.setQueryData(entriesKey, pages);
      throw e;
    }
  };

  // Through the assistant's card, the status changes once confirmed (no optimism before an answer).
  // Straight through the API, it changes at once and rolls back on failure.
  const unpublishRow = (id: string, toastOptions?: ToastOptions) =>
    mutateEntries(async () => {
      // Held to the version the row shows: confirmed after a newer draft was saved, it is refused.
      const version = entries.find((e) => e.id === id)?.version;
      const input = { id, ...(version ? { expectedVersion: version } : {}) };
      const r = await orDirect(await edit('entries_unpublish', input, titleOf(id)), () =>
        applyStatus(id, 'draft', (x) => client.unpublishEntry(x)),
      );
      if (!('output' in r)) return;
      toast.success(`“${titleOf(id)}” unpublished`, toastOptions);
    });

  // A row's Publish says what goes live as surely as the editor's does, and it always asks first:
  // readers and webhooks have a publish at once, and no undo calls that back. The assistant's card,
  // or without it the page's own dialog, with the changed fields where something is live already.
  const publishRow = (e: PreviewEntry) =>
    mutateEntries(async () => {
      const title = titleOf(e.id);
      // Held to the version the row shows: a newer draft saved meanwhile is refused.
      const input = { id: e.id, ...(e.version ? { expectedVersion: e.version } : {}) };
      const r = await edit('entries_publish', input, title);
      if (r === null) {
        publishedRow.current = null;
        setConfirmPublish(e);
      } else if ('output' in r) toast.success(`“${title}” published`);
    });
  const publishConfirmed = (e: PreviewEntry) =>
    mutateEntries(async () => {
      await applyStatus(e.id, 'published', (id) => client.publishEntry(id));
      toast.success(`“${titleOf(e.id)}” published`);
    });

  // Per-row actions for the table; each calls the same handler the list always
  // used, so optimistic status, Undo toasts and confirmations are unchanged.
  const rowActions: EntryRowActions = {
    publish: (e) => void publishRow(e),
    diff: (e) => setDiffEntry(e),
    duplicate: (e) => void duplicate(e),
    unpublish: (e) =>
      void unpublishRow(
        e.id,
        // Republishing restores exactly what was live only for a "published"
        // entry; for a changed one it would ship the unreviewed draft. (An edit
        // made during the toast's 10s window would ship with the Undo too — an
        // accepted edge, since the person chose to edit and then undo.)
        e.status === 'published'
          ? {
              action: {
                label: 'Undo',
                onAction: () => void undoUnpublish([e.id], `“${titleOf(e.id)}” is live again`),
              },
            }
          : undefined,
      ),
    // Trashing is recoverable (Undo in the toast), so it needs no confirmation —
    // unlike the permanent delete offered from the trash.
    trash: (e) => void trash(e),
    restore: (e) => void restore(e),
    purge: (e) => void requestPurge(e),
  };

  const rowLink = (id: string | null) => {
    if (!id || !selectedType) return null;
    const href = `/content/${selectedType.apiId}/${id}`;
    return (
      [...document.querySelectorAll<HTMLElement>('a[data-row-primary]')].find(
        (a) => a.getAttribute('href') === href,
      ) ?? null
    );
  };

  if (!selectedType && typesPending) {
    return (
      <PageSkeleton
        label="entries"
        title={
          <>
            <span className="sr-only">Entries</span>
            <SkeletonText width="min(16rem, 60vw)" />
          </>
        }
      />
    );
  }

  if (!selectedType) {
    return (
      <Empty icon={<FileText />} title="No such content type" className="card mt-6">
        Pick a content type from the list to browse its entries.
      </Empty>
    );
  }

  const count = entries.length;
  const hasQuery =
    (query.filters?.length ?? 0) > 0 ||
    !!query.search ||
    query.where !== undefined ||
    query.mine === true ||
    (query.linksToEntry?.length ?? 0) > 0;
  // Clearing filters keeps the sort, the trash view and kept link parameters: they aren't filters.
  const clearFilters = () =>
    setQuery({ order: query.order, trashed: query.trashed, extra: query.extra });
  const sortBy = (field: string) => {
    const order = nextOrder(query.order?.[0], field);
    setQuery({ ...query, order: order ? [order] : undefined });
  };
  const bulkBar = picked.size > 0;
  const confirmIds =
    confirmBulk === 'publish' || confirmBulk === 'unpublish'
      ? bulkIds(confirmBulk)
      : confirmBulk
        ? [...picked]
        : [];
  const confirmCopy = confirmBulk ? CONFIRM_COPY[confirmBulk] : null;
  // What the batch changes, by name: the first few, then how many more.
  const confirmNames = (
    <ul className="space-y-0.5 text-sm">
      {confirmIds.slice(0, NAMED).map((id) => (
        <li key={id}>
          <span className="font-medium">{titleOf(id)}</span>
          {idDetail(id, titleOf(id))}
        </li>
      ))}
      {confirmIds.length > NAMED ? (
        <li className="text-muted-foreground">and {confirmIds.length - NAMED} more</li>
      ) : null}
    </ul>
  );
  const runConfirmed = () => {
    const action = confirmBulk;
    setConfirmBulk(null);
    if (action === 'publish') void bulk('publish', 'Published', 'published');
    else if (action === 'unpublish') void bulk('unpublish', 'Unpublished', 'draft');
    else if (action) void startJob(action);
  };
  // Where focus goes from an answer asked in place: the bar's button that asked, disabled by the
  // job it may have started, else Clear, or the search once the bar has gone with the selection.
  const afterBulkAsk = (action: BulkConfirm) => {
    const asked = bulkBarRef.current?.querySelector<HTMLButtonElement>(
      `[data-bulk-action="${action}"]`,
    );
    if (asked && !asked.disabled) return asked;
    return (
      bulkBarRef.current?.querySelector<HTMLElement>('[aria-label="Clear selection"]') ??
      document.querySelector<HTMLElement>('[aria-label="Search entries"]')
    );
  };
  // The total is known only for the whole type: filters and the trash count what was read, with a
  // "+" while more may follow.
  const total =
    hasQuery || viewingTrash
      ? undefined
      : countsQuery.data?.find((c) => c.contentType === selectedType.apiId)?.total;
  const counted = `${count}${hasMore ? '+' : ''}`;
  const entriesWord = (n: number) => (n === 1 ? 'entry' : 'entries');
  return (
    <div className="space-y-4">
      <PageHeader
        title={viewingTrash ? `${selectedType.name} trash` : `${selectedType.name} entries`}
        description={
          loading ? (
            <SkeletonText width="5.5rem" />
          ) : viewingTrash ? (
            `${counted} in the trash — restore, or delete permanently`
          ) : total !== undefined && total > count ? (
            `Showing ${count} of ${total} ${entriesWord(total)}`
          ) : total !== undefined ? (
            `${total} ${entriesWord(total)}`
          ) : (
            `${counted} ${entriesWord(count)}`
          )
        }
      >
        <Button
          type="button"
          variant="ghost"
          onClick={() => setViewingTrash(!viewingTrash)}
          disabled={busy}
        >
          {viewingTrash ? 'Back to entries' : 'View trash'}
        </Button>
        {/* A singleton holds one entry, so there is nothing to import into it. */}
        {!viewingTrash && !selectedType.singleton && (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate(`/content/${selectedType.apiId}/import`)}
              disabled={busy}
            >
              Import
            </Button>
            {/* New entry is the shell's (layout/NewEntry.tsx), which links to this type here. */}
          </>
        )}
      </PageHeader>

      {/* Ticking anything swaps the filter bar for what can be done to the ticked entries, held
          under the shell's header; the table's sticky header sits under it (`--sticky-above`). */}
      {bulkBar ? (
        <div ref={bulkBarRef} className="sticky top-(--shell-h) z-20 -my-2 bg-background py-2">
          {viewingTrash ? (
            <EntryBulkBar
              count={picked.size}
              busy={busy || jobRunning}
              deniedJobs={deniedJobs}
              jobsRefusal={JOBS_REFUSAL}
              jobsPending={jobsPending}
              onRestore={() => void startJob('restore')}
              // Deleting for good is always asked first, by name: there is no way back.
              onPurge={() => void requestJob('purge')}
              onClear={() => setPicked(new Set())}
            />
          ) : (
            <EntryBulkBar
              count={picked.size}
              publishable={bulkIds('publish').length}
              unpublishable={bulkIds('unpublish').length}
              busy={busy || jobRunning}
              onPublish={() => void requestBulk('publish')}
              onUnpublish={() => void requestBulk('unpublish')}
              onTrash={() => void requestJob('trash')}
              deniedJobs={deniedJobs}
              jobsRefusal={JOBS_REFUSAL}
              jobsPending={jobsPending}
              onClear={() => setPicked(new Set())}
            />
          )}
          {(confirmBulk === 'unpublish' || confirmBulk === 'trash') && confirmCopy ? (
            <InlineConfirm
              className="mt-2"
              message={confirmCopy.title(plural(confirmIds.length, 'entry', 'entries'))}
              note={confirmCopy.says}
              details={confirmNames}
              cancelLabel={confirmCopy.keep}
              onCancel={() => setConfirmBulk(null)}
              returnFocus={() => afterBulkAsk(confirmBulk)}
            >
              <Button type="button" size="sm" disabled={busy} onClick={runConfirmed}>
                {confirmCopy.button}
              </Button>
            </InlineConfirm>
          ) : null}
        </div>
      ) : (
        <EntryFilterBar
          type={selectedType}
          value={query}
          onChange={setQuery}
          leading={
            // Views are of the live list, not the trash.
            viewingTrash ? undefined : (
              <SavedViewsMenu
                type={selectedType}
                state={listState}
                onApply={(next) => {
                  setPicked(new Set());
                  setListState(next, { push: true });
                }}
                canShare={access?.scopes.includes('content:manage') ?? false}
                subject={access?.subject}
              />
            )
          }
          trailing={
            <ColumnPicker
              type={selectedType}
              columns={listState.columns}
              onChange={(columns) => setListState({ ...listState, columns })}
            />
          }
        />
      )}
      <p className="sr-only" aria-live="polite">
        {picked.size > 0 ? `${plural(picked.size, 'entry', 'entries')} selected` : ''}
      </p>

      {entryJob && (
        <BulkJobProgress
          job={entryJob.job}
          verbs={JOB_VERBS[entryJob.action]}
          nouns={['entry', 'entries']}
          where="the list"
          onDismiss={() => setEntryJob(null)}
          onCancel={() => void cancelJob(entryJob.job.id)}
          cancelling={cancellingJob}
          // Started from the bar, whose buttons now wait: focus goes to Stop, not the page.
          takeFocus
        />
      )}

      {unnamedFailures && (
        <Alert variant="destructive">
          <AlertTitle>{plural(unnamedFailures.count, 'entry', 'entries')} failed</AlertTitle>
          <AlertDescription>
            <p>
              The job’s report couldn’t be read ({unnamedFailures.reason}), so they can’t be named
              here. Those still listed stay ticked.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setUnnamedFailures(null)}
            >
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {bulkFailures && bulkFailures.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>
            {bulkFailures.length} {bulkFailures.length === 1 ? 'entry' : 'entries'} failed
          </AlertTitle>
          <AlertDescription>
            <ul className="space-y-0.5">
              {bulkFailures.map((f) => (
                <li key={f.id}>
                  <span className="font-medium">{f.title}</span>
                  {idDetail(f.id, f.title)}
                  {f.error ? `: ${f.error}` : ''}
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setBulkFailures(null)}
            >
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loading ? (
        <>
          <LoadingStatus>Loading {selectedType.name} entries…</LoadingStatus>
          <EntriesTable
            type={selectedType}
            entries={[]}
            locale={conn.locale}
            picked={picked}
            busy
            viewingTrash={viewingTrash}
            hrefFor={(e) => `/content/${selectedType.apiId}/${e.id}`}
            onPick={() => {}}
            onPickAll={() => {}}
            actions={rowActions}
            order={query.order?.[0]}
            columns={listState.columns}
            pending={rememberedCount(countKey)}
          />
        </>
      ) : entries.length === 0 && !hasQuery ? (
        <EmptyState
          icon={FileText}
          title="No entries yet"
          description={`Create the first ${selectedType.name} entry to get started.`}
        >
          <Button
            type="button"
            onClick={() => navigate(`/content/${selectedType.apiId}/new`)}
            disabled={busy}
          >
            Create entry
          </Button>
        </EmptyState>
      ) : (
        <Refreshing busy={entriesQuery.isPlaceholderData}>
          <div className={bulkBar ? 'md:[--sticky-above:4rem]' : undefined}>
            <EntriesTable
              type={selectedType}
              entries={entries}
              locale={conn.locale}
              picked={picked}
              busy={busy}
              viewingTrash={viewingTrash}
              hrefFor={(e) => `/content/${selectedType.apiId}/${e.id}`}
              onPick={pick}
              onPickAll={(all) => setPicked(all ? new Set(entries.map((e) => e.id)) : new Set())}
              actions={rowActions}
              order={query.order?.[0]}
              columns={listState.columns}
              onSort={sortBy}
              onLoadMore={hasMore ? () => void entriesQuery.fetchNextPage() : undefined}
              loadingMore={entriesQuery.isFetchingNextPage}
              // A search that missed keeps the headers, and says so in a row under them.
              empty={
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                  No entries match the current filters.
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="px-0"
                    onClick={clearFilters}
                    disabled={busy}
                  >
                    Clear filters
                  </Button>
                </span>
              }
            />
          </div>
        </Refreshing>
      )}

      {/* Publishing and deleting for good have no way back, so they are the modal ones: the rest
          of the bulk bar asks in place, under it. */}
      <AlertDialog
        open={confirmBulk === 'publish' || confirmBulk === 'purge'}
        onOpenChange={(open) => {
          if (!open) setConfirmBulk(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmCopy?.title(plural(confirmIds.length, 'entry', 'entries'))}
            </AlertDialogTitle>
            <AlertDialogDescription>{confirmCopy?.says}</AlertDialogDescription>
          </AlertDialogHeader>
          {confirmNames}
          <AlertDialogFooter>
            <AlertDialogCancel>{confirmCopy?.keep}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmBulk === 'purge' ? 'destructive' : 'default'}
              disabled={busy}
              onClick={runConfirmed}
            >
              {confirmCopy?.button}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PublishConfirm
        open={confirmPublish !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmPublish(null);
        }}
        title={askedPublish ? titleOf(askedPublish.id) : ''}
        status={askedPublish?.status}
        compare={askedPublish ? { client, entry: askedPublish, locale: conn.locale } : undefined}
        busy={busy}
        onConfirm={() => {
          const entry = confirmPublish;
          setConfirmPublish(null);
          publishedRow.current = entry?.id ?? null;
          if (entry) void publishConfirmed(entry);
        }}
        // The row's Publish goes once it is live; its title link keeps the keyboard on the row.
        // Kept as it was, the button is still there, and focus goes back to it.
        returnFocus={() => rowLink(publishedRow.current)}
      />

      {/* Permanent deletion names the entry and says plainly that it cannot be
          undone — it is the only entry action with no way back. */}
      <AlertDialog
        open={confirmPurge !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmPurge(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Permanently delete “{confirmPurge ? titleOf(confirmPurge.id) : ''}”?
              {confirmPurge ? idDetail(confirmPurge.id, titleOf(confirmPurge.id)) : null}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the entry and its entire version history. It can&rsquo;t be undone. If
              other published entries link to it, the delete is refused so their links don&rsquo;t
              break.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep in trash</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const entry = confirmPurge;
                setConfirmPurge(null);
                if (entry) void purge(entry);
              }}
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={!!diffEntry} onOpenChange={(o) => !o && setDiffEntry(null)}>
        <ResponsiveSheetContent className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Diff vs published</SheetTitle>
            <SheetDescription>Draft changes since this entry was last published.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            {diffEntry && <EntryDiff client={client} entry={diffEntry} locale={conn.locale} />}
          </div>
        </ResponsiveSheetContent>
      </Sheet>
    </div>
  );
}

/** The pages' entries in order, each once: a refetch can move an edited entry onto a later page. */
function dedupe(pages: readonly EntryPage[] | undefined): PreviewEntry[] {
  const seen = new Set<string>();
  const out: PreviewEntry[] = [];
  for (const page of pages ?? []) {
    for (const e of page.items) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}
