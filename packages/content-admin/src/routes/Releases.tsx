import { Ago } from '@commerceworker/content-admin/components/ago';
import { ConfirmDialog } from '@commerceworker/content-admin/components/ConfirmDialog';
import {
  type EntryRef,
  entryPath,
  entryRef,
} from '@commerceworker/content-admin/components/dashboard/entry-titles';
import { useEntriesById } from '@commerceworker/content-admin/components/dashboard/use-entries-by-id';
import {
  DiscardAsk,
  GuardCancel,
  useDiscardGuard,
} from '@commerceworker/content-admin/components/discard-guard';
import { EmptyState, PageHeader } from '@commerceworker/content-admin/components/page';
import { ReleasePublishConfirm } from '@commerceworker/content-admin/components/ReleasePublishConfirm';
import { ResponsiveSheetContent } from '@commerceworker/content-admin/components/responsive-sheet';
import { StatusBadge } from '@commerceworker/content-admin/components/status';
import { When } from '@commerceworker/content-admin/components/when';
import { humanize, plural, statusLabel } from '@commerceworker/content-admin/lib/format';
import { Link } from '@commerceworker/content-admin/router';
import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import {
  Catalog,
  CatalogEmpty,
  CatalogFigure,
  CatalogRow,
  CatalogTile,
  ListSearch,
  ListToolbar,
} from '@commerceworker/ui/catalog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@commerceworker/ui/dialog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { Segmented, SegmentedItem } from '@commerceworker/ui/segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from '@commerceworker/ui/sheet';
import { Skeleton } from '@commerceworker/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@commerceworker/ui/tabs';
import { CalendarClock, PackageOpen, Plus, Rocket, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useClient } from '../lib/client-context';
import { refusedSave } from '../lib/management';
import {
  useAllEntriesQuery,
  useContentTypesQuery,
  useInvalidate,
  useScopedQuery,
} from '../lib/queries';
import { useToast } from '../lib/toast';

/** Which scheduled publishes the list shows. */
type ScheduledFilter = 'all' | 'pending';

/** Which releases the list shows. */
type ReleaseFilter = 'all' | 'open' | 'published' | 'archived';

/** Local datetime → ISO, defaulting to one hour out for the picker initial value. */
function defaultScheduleLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  // datetime-local wants `YYYY-MM-DDTHH:mm` in local time.
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

/**
 * Releases and the scheduled-actions queue. Each release is a row with what decides whether to ship
 * it: how many entries it holds, when it goes (or went) out, and its status. Opening it is the
 * row's path; publishing lives in the release, beside its members, behind the publish confirm.
 */
export function Releases() {
  const { client, busy, run } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<ReleaseFilter>('all');
  const [scheduledShow, setScheduledShow] = useState<ScheduledFilter>('all');
  const releasesQuery = useScopedQuery(['releases'], () => client.listReleases());
  const scheduledQuery = useScopedQuery(['scheduled-actions'], () => client.listScheduledActions());
  const releases = releasesQuery.data ?? [];
  const scheduled = scheduledQuery.data ?? [];
  const loading = releasesQuery.isPending || scheduledQuery.isPending;
  const scheduledShown = scheduled.filter((a) => scheduledShow === 'all' || a.status === 'pending');
  const needle = query.trim().toLowerCase();
  const shown = releases.filter(
    (r) =>
      (show === 'all' || r.status === show) &&
      (!needle || `${r.title} ${r.description ?? ''}`.toLowerCase().includes(needle)),
  );
  // Scheduled entries are named by one batched lookup, never by their ids.
  const scheduledEntries = useEntriesById(
    scheduled.filter((a) => a.entityType === 'Entry').map((a) => a.entityId),
  );
  /** When a pending scheduled publish will ship the release, if one does. */
  const scheduledFor = (id: string) =>
    scheduled
      .filter((a) => a.entityType === 'Release' && a.entityId === id && a.status === 'pending')
      .map((a) => a.scheduledFor)
      .sort()[0];

  // Publishing a release publishes its entries, so entry lists/details go
  // stale too; the entries invalidations are cheap no-ops when unmounted.
  // The 'release' prefix covers every detail sheet's cache — without it a
  // just-published release could reopen as still-editable within staleTime.
  const reload = () =>
    invalidate(['releases'], ['scheduled-actions'], ['release'], ['entries'], ['entry']);

  const remove = async (id: string) => {
    await client.deleteRelease(id);
    toast.success('Release deleted');
    if (openId === id) setOpenId(null);
    await reload();
  };

  /** What a scheduled action acts on, for naming its row. */
  const targetOf = (a: (typeof scheduled)[number]) =>
    (a.entityType === 'Release'
      ? releases.find((r) => r.id === a.entityId)?.title
      : scheduledEntries.refs.get(a.entityId)?.title) ?? 'a deleted item';

  const cancel = (id: string) =>
    run(async () => {
      await client.cancelScheduledAction(id);
      toast.success('Scheduled action canceled');
      await reload();
    });

  const pendingCount = scheduled.filter((a) => a.status === 'pending').length;

  return (
    <div className="space-y-4">
      <PageHeader title="Releases" subtitle="Bundle entries and ship them atomically.">
        <Button type="button" size="sm" onClick={() => setCreating(true)} disabled={busy}>
          <Plus aria-hidden="true" /> New release
        </Button>
      </PageHeader>

      <Tabs defaultValue="releases">
        <TabsList>
          <TabsTrigger value="releases">Releases</TabsTrigger>
          <TabsTrigger value="scheduled">
            Scheduled
            {pendingCount > 0 && (
              <Badge variant="secondary" className="ml-2">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="releases" className="mt-4">
          {loading ? (
            <div className="card space-y-3 p-5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : releases.length === 0 ? (
            <EmptyState
              icon={PackageOpen}
              title="No releases yet"
              description="Group entries into a release to publish them together at one moment."
            >
              <Button type="button" onClick={() => setCreating(true)}>
                Create release
              </Button>
            </EmptyState>
          ) : (
            <div className="card overflow-clip">
              <ListToolbar summary={`${shown.length} shown`}>
                <ListSearch
                  label="Search releases"
                  placeholder="Search releases"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onClear={() => setQuery('')}
                />
                <Segmented
                  aria-label="Show releases"
                  value={show}
                  onValueChange={(v) => setShow(v as ReleaseFilter)}
                >
                  <SegmentedItem value="all">All</SegmentedItem>
                  <SegmentedItem value="open">Open</SegmentedItem>
                  <SegmentedItem value="published">Published</SegmentedItem>
                  <SegmentedItem value="archived">Archived</SegmentedItem>
                </Segmented>
              </ListToolbar>
              {shown.length === 0 ? (
                <CatalogEmpty
                  onClear={() => {
                    setQuery('');
                    setShow('all');
                  }}
                >
                  No releases match.
                </CatalogEmpty>
              ) : (
                <Catalog aria-label="Releases" className="pt-0">
                  {shown.map((r) => {
                    const at = scheduledFor(r.id);
                    return (
                      <CatalogRow
                        key={r.id}
                        className="[&_[data-slot=item-description]]:line-clamp-2"
                        media={
                          <CatalogTile>
                            <PackageOpen aria-hidden="true" />
                          </CatalogTile>
                        }
                        title={
                          // Opening is the row's main path; publishing waits inside, with its
                          // members in view.
                          <button
                            type="button"
                            className="hit-area break-words text-left font-medium hover:underline"
                            onClick={() => setOpenId(r.id)}
                          >
                            {r.title}
                          </button>
                        }
                        meta={
                          <>
                            {r.publishedAt ? (
                              <>
                                Published <Ago at={r.publishedAt} />
                              </>
                            ) : at ? (
                              <>
                                Scheduled for <When at={at} />
                              </>
                            ) : (
                              <>
                                Created <Ago at={r.createdAt} />
                              </>
                            )}
                            {r.description ? ` · ${r.description}` : ''}
                          </>
                        }
                        aside={
                          <>
                            <StatusBadge
                              status={r.status === 'open' && at ? 'scheduled' : r.status}
                            />
                            <CatalogFigure label="Entries">{r.itemCount}</CatalogFigure>
                          </>
                        }
                        actions={
                          r.status !== 'published' ? (
                            <ConfirmDialog
                              message={`Delete “${r.title}”?`}
                              note="Its entries stay as they are; the release itself can’t be recovered."
                              confirmLabel="Delete release"
                              busy={busy}
                              onConfirm={() => remove(r.id)}
                            >
                              {(ask) => (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  aria-label={`Delete “${r.title}”`}
                                  onClick={ask}
                                  disabled={busy}
                                >
                                  Delete
                                </Button>
                              )}
                            </ConfirmDialog>
                          ) : undefined
                        }
                      />
                    );
                  })}
                </Catalog>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="scheduled" className="mt-4">
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : scheduled.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="Nothing scheduled"
              description="Schedule a release or entry to publish automatically at a future time."
            />
          ) : (
            <div className="card overflow-clip">
              <ListToolbar summary={`${scheduledShown.length} shown`}>
                <Segmented
                  aria-label="Show scheduled publishes"
                  className="ml-auto"
                  value={scheduledShow}
                  onValueChange={(v) => setScheduledShow(v as ScheduledFilter)}
                >
                  <SegmentedItem value="all">All</SegmentedItem>
                  <SegmentedItem value="pending">Pending</SegmentedItem>
                </Segmented>
              </ListToolbar>
              <Catalog aria-label="Scheduled publishes" className="pt-0">
                {scheduledShown.map((a) => (
                  <CatalogRow
                    key={a.id}
                    media={
                      <CatalogTile>
                        <CalendarClock aria-hidden="true" />
                      </CatalogTile>
                    }
                    title={
                      a.entityType === 'Release' ? (
                        (releases.find((r) => r.id === a.entityId)?.title ?? (
                          <span className="text-muted-foreground">A deleted release</span>
                        ))
                      ) : (
                        <EntryLink
                          entry={scheduledEntries.refs.get(a.entityId)}
                          resolving={scheduledEntries.resolving(a.entityId)}
                        />
                      )
                    }
                    meta={
                      <>
                        {humanize(a.action)} · <When at={a.scheduledFor} />
                      </>
                    }
                    aside={<StatusBadge status={a.status} />}
                    actions={
                      a.status === 'pending' ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          aria-label={`Cancel ${humanize(a.action)} of ${targetOf(a)}`}
                          onClick={() => cancel(a.id)}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                      ) : undefined
                    }
                  />
                ))}
              </Catalog>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <CreateReleaseDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={async (input) => {
          let failed: unknown;
          await run(async () => {
            try {
              const created = await client.createRelease(input);
              setCreating(false);
              toast.success('Release created');
              await reload();
              setOpenId(created.id);
            } catch (err) {
              failed = err;
            }
          });
          if (failed === undefined) return;
          // It may have landed: the list behind the dialog is where to check.
          if (!refusedSave(failed)) await reload();
          throw failed;
        }}
        busy={busy}
      />

      <ReleaseDetailSheet
        releaseId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => void reload()}
      />
    </div>
  );
}

export function CreateReleaseDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { title: string; description?: string }) => Promise<void>;
  busy: boolean;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // Its own write, not `busy`, which any action on the page sets.
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const guard = useDiscardGuard({
    saving,
    open: props.open,
    dirty: title.trim() !== '' || description.trim() !== '',
    onOpenChange: props.onOpenChange,
  });

  const create = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await props.onCreate({ title: title.trim(), description: description.trim() || undefined });
    } catch (err) {
      setError(guard.saveFailed(err));
    } finally {
      setSaving(false);
    }
  };

  // Reset fields each time the dialog opens.
  useEffect(() => {
    if (props.open) {
      setTitle('');
      setDescription('');
      setError(undefined);
    }
  }, [props.open]);

  return (
    <Dialog open={props.open} onOpenChange={guard.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New release</DialogTitle>
          <DialogDescription>Name the release; add entries after creating it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="release-title">Title</Label>
            <Input
              id="release-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Spring campaign"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="release-desc">Description</Label>
            <Input
              id="release-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        {error && <DialogError>{error}</DialogError>}
        <DialogFooter>
          <DiscardAsk guard={guard} message="Discard this release?">
            <GuardCancel guard={guard} />
            <Button
              type="button"
              disabled={!title.trim() || props.busy}
              onClick={() => void create()}
            >
              {/* No natural key, so a retry could make a second one: the button says so. */}
              {guard.unconfirmed ? 'Create again' : 'Create'}
            </Button>
          </DiscardAsk>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Detail panel for one release: members, add/remove, publish, and scheduling. */
function ReleaseDetailSheet(props: {
  releaseId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { client, conn, busy, run } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  // The entry picker resets in-render whenever a different release is opened.
  const [pickState, setPickState] = useState({ releaseId: props.releaseId, id: '' });
  if (pickState.releaseId !== props.releaseId) {
    setPickState({ releaseId: props.releaseId, id: '' });
  }
  const pick = pickState.releaseId === props.releaseId ? pickState.id : '';
  const setPick = (id: string) => setPickState({ releaseId: props.releaseId, id });
  const [when, setWhen] = useState(defaultScheduleLocal);
  // Which release's publish is awaiting confirmation; keyed by id so opening
  // another release never inherits a half-answered confirm.
  const [askingFor, setAskingFor] = useState<string | null>(null);

  const detail =
    useScopedQuery(['release', props.releaseId], () => client.getRelease(props.releaseId ?? ''), {
      enabled: !!props.releaseId,
    }).data ?? null;
  const entriesQuery = useAllEntriesQuery({ enabled: !!props.releaseId });
  const entries = entriesQuery.data ?? [];

  const refresh = async () => {
    await invalidate(['release', props.releaseId]);
    props.onChanged();
  };

  const id = props.releaseId;
  const open = !!id;
  const release = detail?.release;
  const items = detail?.items ?? [];
  const memberIds = new Set(items.map((i) => i.entityId));
  // Members are named by one batched lookup of exactly their ids, so a member past the picker's
  // capped list is still named rather than shown as an id.
  const members = useEntriesById(items.map((i) => i.entityId));
  const types = useContentTypesQuery().data ?? [];
  const candidates = entries.filter((e) => !memberIds.has(e.id));
  const editable = release?.status === 'open';
  const asking = !!id && askingFor === id;

  const addEntry = () =>
    run(async () => {
      if (!id || !pick) return;
      await client.addEntryToRelease(id, { entityId: pick });
      setPick('');
      toast.success('Entry added');
      await refresh();
    });

  const removeEntry = (entityId: string) =>
    run(async () => {
      if (!id) return;
      await client.removeEntryFromRelease(id, entityId);
      await refresh();
    });

  const publishNow = () =>
    run(async () => {
      if (!id) return;
      await client.publishRelease(id);
      toast.success('Release published');
      props.onClose();
      props.onChanged();
    });

  const schedule = () =>
    run(async () => {
      if (!id) return;
      await client.scheduleAction({
        action: 'publish',
        entityType: 'Release',
        entityId: id,
        scheduledFor: new Date(when).toISOString(),
      });
      toast.success('Release scheduled');
      props.onClose();
      props.onChanged();
    });

  return (
    <Sheet open={open} onOpenChange={(o) => !o && props.onClose()}>
      <ResponsiveSheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{release?.title ?? 'Release'}</SheetTitle>
          {release ? (
            <SheetDescription>
              {plural(items.length, 'entry', 'entries')} · {statusLabel(release.status)}
            </SheetDescription>
          ) : (
            <>
              <SheetDescription className="sr-only">Loading the release</SheetDescription>
              <Skeleton className="h-4 w-40" />
            </>
          )}
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          {editable && (
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label>Add entry</Label>
                <Select value={pick} onValueChange={setPick}>
                  <SelectTrigger aria-label="Add entry">
                    <SelectValue placeholder="Pick an entry…" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.length === 0 ? (
                      <SelectItem value="__none" disabled>
                        No more entries
                      </SelectItem>
                    ) : (
                      candidates.map((e) => {
                        const ref = entryRef(e, types, conn.locale);
                        return (
                          <SelectItem key={e.id} value={e.id}>
                            {ref.title}
                            <span className="ml-2 text-muted-foreground">
                              {ref.typeName} · {statusLabel(e.status)}
                            </span>
                          </SelectItem>
                        );
                      })
                    )}
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" onClick={addEntry} disabled={!pick || busy}>
                Add
              </Button>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="font-medium text-sm">Entries</h3>
            {items.length === 0 ? (
              <p className="text-muted-foreground text-sm">No entries in this release yet.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {items.map((it) => {
                  const member = members.refs.get(it.entityId);
                  return (
                    <li
                      key={it.entityId}
                      className="flex items-center justify-between gap-2 px-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2 text-sm">
                        <EntryLink entry={member} resolving={members.resolving(it.entityId)} />
                        {it.action === 'unpublish' ? (
                          <Badge variant="outline">Unpublish</Badge>
                        ) : null}
                      </div>
                      {editable && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="hit-area size-7"
                          aria-label={`Remove “${member?.title ?? 'this entry'}” from the release`}
                          onClick={() => removeEntry(it.entityId)}
                          disabled={busy}
                        >
                          <X className="size-4" aria-hidden="true" />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {editable && (
            <div className="space-y-3 border-t pt-4">
              {asking && id ? (
                <ReleasePublishConfirm
                  releaseId={id}
                  releaseTitle={release?.title ?? 'this release'}
                  busy={busy}
                  onCancel={() => setAskingFor(null)}
                  returnFocus={() => document.getElementById('release-sheet-publish')}
                  onConfirm={() => {
                    setAskingFor(null);
                    void publishNow();
                  }}
                />
              ) : (
                <Button
                  id="release-sheet-publish"
                  type="button"
                  className="w-full"
                  onClick={() => setAskingFor(id)}
                  disabled={items.length === 0 || busy}
                >
                  <Rocket className="size-4" />
                  Publish now…
                </Button>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="schedule-when">Or schedule for</Label>
                <div className="flex gap-2">
                  <Input
                    id="schedule-when"
                    type="datetime-local"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={schedule}
                    disabled={items.length === 0 || !when || busy}
                  >
                    <CalendarClock className="size-4" />
                    Schedule
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </ResponsiveSheetContent>
    </Sheet>
  );
}

/**
 * An entry known only by id, named and linked: its title once the lookup answers, a placeholder
 * while it may, and "Entry no longer available" when it was deleted or isn't visible. Never an id.
 */
function EntryLink({ entry, resolving }: { entry: EntryRef | undefined; resolving: boolean }) {
  if (entry) {
    return (
      <Link
        to={entryPath(entry)}
        className="min-w-0 truncate font-medium text-foreground hover:underline"
      >
        {entry.title}
      </Link>
    );
  }
  if (resolving) return <Skeleton className="inline-block h-4 w-32 align-middle" aria-hidden />;
  return <span className="text-muted-foreground">Entry no longer available</span>;
}
