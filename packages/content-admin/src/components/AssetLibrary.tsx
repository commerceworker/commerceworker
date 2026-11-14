import { AssetDetailSheet } from '@commerceworker/content-admin/components/AssetDetailSheet';
import { AssetPreview } from '@commerceworker/content-admin/components/AssetPreview';
import { AssetBulkBar } from '@commerceworker/content-admin/components/assets/AssetBulkBar';
import { AssetBulkJobProgress } from '@commerceworker/content-admin/components/assets/AssetBulkJobProgress';
import { AssetCollectionList } from '@commerceworker/content-admin/components/assets/AssetCollectionList';
import { AssetCollectionView } from '@commerceworker/content-admin/components/assets/AssetCollectionView';
import {
  AssetFilterBar,
  type AssetView,
} from '@commerceworker/content-admin/components/assets/AssetFilterBar';
import { AssetFolderTree } from '@commerceworker/content-admin/components/assets/AssetFolderTree';
import { AssetIngestBadges } from '@commerceworker/content-admin/components/assets/AssetIngestBadges';
import { AssetInUseNotice } from '@commerceworker/content-admin/components/assets/AssetInUseNotice';
import {
  AssetFacetChips,
  AssetSearchBox,
} from '@commerceworker/content-admin/components/assets/AssetSearch';
import {
  AssetUploadList,
  type UploadItem,
  uploadSummary,
} from '@commerceworker/content-admin/components/assets/AssetUploadList';
import {
  AssetZipProgress,
  useAssetZip,
} from '@commerceworker/content-admin/components/assets/AssetZipProgress';
import { ConfirmDialog } from '@commerceworker/content-admin/components/ConfirmDialog';
import {
  LoadingStatus,
  Refreshing,
  rememberCount,
  rememberedCount,
} from '@commerceworker/content-admin/components/loading';
import { EmptyState, PageHeader } from '@commerceworker/content-admin/components/page';
import { StatusBadge } from '@commerceworker/content-admin/components/status';
import {
  ALL_FOLDERS,
  type AssetBulkAction,
  type AssetFilterState,
  activeFilterCount,
  addedSummary,
  allPages,
  assetLibraryQuery,
  assetName,
  assetSearchQuery,
  BULK_VERBS,
  chunked,
  type FacetChip,
  type FolderSelection,
  facetChips,
  fileSize,
  RIGHTS_BADGE,
  rightsState,
  runBulk,
  runsAsJob,
  uploadInParts,
  uploadsInParts,
} from '@commerceworker/content-admin/lib/assets';
import { bulkSummary, jobFailures, jobOutcome } from '@commerceworker/content-admin/lib/bulk-jobs';
import { humanize, plural } from '@commerceworker/content-admin/lib/format';
import { useNow } from '@commerceworker/content-admin/lib/use-now';
import {
  type Asset,
  type AssetCollection,
  type AssetFolder,
  MAX_COLLECTION_CHANGE,
} from '@commerceworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Card } from '@commerceworker/ui/card';
import { Checkbox } from '@commerceworker/ui/checkbox';
import { cn } from '@commerceworker/ui/lib/utils';
import { Skeleton, SkeletonPill, SkeletonText } from '@commerceworker/ui/skeleton';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ImageIcon, Trash2, Upload } from 'lucide-react';
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../lib/client-context';
import {
  ApiError,
  type AssetBulkRequest,
  type AssetInUse,
  apiErrorMessage,
  assetUsageOf,
  type BulkJobSummary,
} from '../lib/management';
import { useInvalidate, useQueryKeys, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** How often a running bulk job is asked how far it has got (as an import job is). */
const BULK_JOB_POLL_MS = 2000;

/** Label for a hosted video's processing state, shown beside the asset status. */
const VIDEO_STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting upload',
  processing: 'Processing',
  ready: 'Ready',
  error: 'Failed',
};

const VIEW_KEY = 'cw.assets.view';

/** Grid or list is how this browser likes the library, kept across visits (like the pane split). */
function useView(): [AssetView, (v: AssetView) => void] {
  const [view, setView] = useState<AssetView>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const set = useCallback((v: AssetView) => {
    setView(v);
    try {
      if (v === 'grid') localStorage.removeItem(VIEW_KEY);
      else localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
  }, []);
  return [view, set];
}

// The server's own words (a refused publish says why: "under embargo until …"), not the request.
const message = (e: unknown) => apiErrorMessage(e);

/** How long typing pauses before the library searches. */
const SEARCH_DEBOUNCE_MS = 250;

/** How often the library looks again while an asset on screen is still being processed. */
const INGEST_POLL_MS = 4000;

const ingesting = (a: Asset) => a.ingestStatus === 'pending' || a.ingestStatus === 'processing';

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * The asset library: folders beside a filtered, paged grid or list. Upload by picking or dropping
 * any number of files (into the open folder), select several to move, publish or archive them, and
 * archive one at a time, then delete what is archived; a delete the API refuses shows the entries
 * that use the asset.
 */
export function AssetLibrary(props: { locale: string }) {
  const { locale } = props;
  const { client } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const keys = useQueryKeys();
  const [folder, setFolder] = useState<FolderSelection>(ALL_FOLDERS);
  const [filters, setFilters] = useState<AssetFilterState>({});
  const [view, setView] = useView();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<Asset | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [inUse, setInUse] = useState<({ asset: Asset } & AssetInUse) | null>(null);
  const refusedInUse = useRef<({ asset: Asset } & AssetInUse) | null>(null);
  // A bulk action's failures, by asset: named in place, and still selected to try again.
  const [bulkFailures, setBulkFailures] = useState<{
    readonly verb: string;
    readonly items: readonly { name: string; error: string }[];
    /** How many failed when they can't be named (the job report was refused). */
    readonly unnamed?: number;
  } | null>(null);
  // A bulk action running as a job (past ASSET_BULK_JOB_THRESHOLD, or any tagging), and its progress.
  const [bulkJob, setBulkJob] = useState<{
    readonly action: AssetBulkAction;
    readonly job: BulkJobSummary;
  } | null>(null);
  // The open collection, shown in place of the library; null while the library shows.
  const [collectionId, setCollectionId] = useState<string | null>(null);
  // A collection just made: its heading takes focus when it opens.
  const [createdCollection, setCreatedCollection] = useState<string | null>(null);
  // Zips, followed until they are built: the selection's, and a collection's (held here, not in
  // the collection's view, so a zip started there can still be downloaded after leaving it).
  const zip = useAssetZip();
  const collectionZip = useAssetZip();
  // Where the last batch of uploads went, when that wasn't the open folder: a collection.
  const [uploadInto, setUploadInto] = useState<string | null>(null);
  // Each upload's cancel: a file still waiting is skipped, a multipart upload aborted.
  const uploadControls = useRef(new Map<string, AbortController>());
  const fileRef = useRef<HTMLInputElement>(null);
  // Rights expire on a clock: "Expires soon" turns to "Expired" without a reload.
  const now = useNow(60_000);

  const [searchText, setSearchText] = useState('');
  // Typing searches once it pauses; clearing the box puts the library back at once.
  const debounced = useDebounced(searchText.trim(), SEARCH_DEBOUNCE_MS);
  const q = searchText.trim() === '' ? '' : debounced;
  const searching = q !== '';

  const query = useMemo(() => assetLibraryQuery(folder, filters), [folder, filters]);
  const pages = useInfiniteQuery({
    queryKey: keys.assetLibrary(query),
    queryFn: ({ pageParam }) =>
      client.listAssets(pageParam ? { ...query, cursor: pageParam } : query),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor,
    enabled: !searching,
    // Ingest finishes on its own time: look again while anything shown is still processing.
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.items.some(ingesting)) ? INGEST_POLL_MS : false,
    // Another folder or filter keeps the assets on screen (dimmed if slow) until its own arrive.
    placeholderData: keepPreviousData,
  });
  // A search ranks by relevance and comes back whole (up to 100), with its facet counts.
  const searchQuery = useMemo(() => assetSearchQuery(q, folder, filters), [q, folder, filters]);
  const search = useQuery({
    queryKey: keys.assetLibrary({ search: searchQuery }),
    queryFn: () => client.searchAssets(searchQuery),
    enabled: searching,
    refetchInterval: (query) => (query.state.data?.items.some(ingesting) ? INGEST_POLL_MS : false),
    // A chip narrowing the search keeps the results (and the chips) up while the next ones load.
    placeholderData: keepPreviousData,
  });
  const assets = useMemo(
    () =>
      searching ? (search.data?.items ?? []) : (pages.data?.pages.flatMap((p) => p.items) ?? []),
    [searching, search.data, pages.data],
  );
  // The open asset follows what the library fetched (a poll that saw ingest finish); the sheet
  // keeps the editor's unsaved values, since it fills its form only when another asset opens.
  useEffect(() => {
    setOpen((current) => {
      if (!current) return current;
      const fresh = assets.find((a) => a.id === current.id);
      return fresh && fresh !== current ? fresh : current;
    });
  }, [assets]);
  const loading = searching ? search.isPending : pages.isPending;
  const loadError = searching ? search.error : pages.error;
  const refreshing = searching ? search.isPlaceholderData : pages.isPlaceholderData;
  const searchBusy = searching && (search.isPending || search.isPlaceholderData);
  const searchSummary = !searching
    ? ''
    : searchBusy || !search.data
      ? 'Searching…'
      : search.data.total === 0
        ? `No matches for “${q}”`
        : `${search.data.total} ${search.data.total === 1 ? 'match' : 'matches'} for “${q}”`;
  // Skeletons: the first page comes back as long as the library was last time (this session);
  // the next page, as a row of them after the last asset.
  const countKey = `assets:${view}`;
  const pending = loading
    ? rememberedCount(countKey, view === 'grid' ? 8 : 6)
    : !searching && pages.isFetchingNextPage
      ? 4
      : 0;
  useEffect(() => {
    if (!searching && pages.data && !pages.isPlaceholderData)
      rememberCount(countKey, assets.length);
  }, [searching, countKey, pages.data, pages.isPlaceholderData, assets.length]);
  const folders = useScopedQuery(['asset-folders'], () => client.listAssetFolders()).data ?? [];
  const tags = useScopedQuery(['tags'], () => client.listTags(), { silent: true }).data ?? [];
  const collectionsQuery = useScopedQuery(
    ['asset-collections'],
    () =>
      allPages<AssetCollection>((cursor) =>
        client.listAssetCollections({ limit: 100, ...(cursor ? { cursor } : {}) }),
      ),
    { silent: true },
  );
  const collections = collectionsQuery.data ?? [];
  const openCollection = collectionId ? collections.find((c) => c.id === collectionId) : undefined;
  // A collection deleted elsewhere (or in another tab) closes once the list no longer has it.
  useEffect(() => {
    if (collectionId && collectionsQuery.data && !openCollection) setCollectionId(null);
  }, [collectionId, collectionsQuery.data, openCollection]);
  const chips = useMemo(
    () => (search.data ? facetChips(search.data.facets, tags, folders) : null),
    [search.data, tags, folders],
  );

  const reload = () => invalidate(['assets']);
  const reloadFolders = () => invalidate(['asset-folders']);
  const reloadCollections = () => invalidate(['asset-collections']);
  const fail = (e: unknown) => toast.error(message(e));
  const openFolder = folder.kind === 'folder' ? folders.find((f) => f.id === folder.id) : undefined;

  const changeFolder = (next: FolderSelection) => {
    setCollectionId(null);
    setFolder(next);
    setSelected(new Set());
    setBulkFailures(null);
  };
  const changeFilters = (next: AssetFilterState) => {
    setFilters(next);
    setSelected(new Set());
    setBulkFailures(null);
  };
  // A new search shows other assets: a selection (or its failures) the results hide would
  // otherwise still be acted on.
  const changeSearch = (next: string) => {
    setSearchText(next);
    setSelected(new Set());
    setBulkFailures(null);
  };

  // --- search ---------------------------------------------------------------
  const chipActive = (chip: FacetChip) =>
    chip.facet === 'kind'
      ? filters.kind === chip.value
      : chip.facet === 'tag'
        ? filters.tag === chip.value
        : chip.value === 'root'
          ? folder.kind === 'root'
          : folder.kind === 'folder' && folder.id === chip.value;
  // A chip narrows the search the way the filter bar and the folder tree do, so the two agree.
  const toggleChip = (chip: FacetChip) => {
    const on = chipActive(chip);
    if (chip.facet === 'folder') {
      changeFolder(
        on
          ? ALL_FOLDERS
          : chip.value === 'root'
            ? { kind: 'root' }
            : { kind: 'folder', id: chip.value },
      );
    } else if (chip.facet === 'kind') {
      changeFilters({
        ...filters,
        kind: on ? undefined : (chip.value as AssetFilterState['kind']),
      });
    } else {
      changeFilters({ ...filters, tag: on ? undefined : chip.value });
    }
  };

  // --- what ingest found ----------------------------------------------------
  const openOriginal = (id: string) =>
    void client
      .getAsset(id)
      .then(setOpen)
      .catch(() => toast.error('The original asset is no longer in the library'));
  const retryIngest = (a: Asset) =>
    void client
      .reingestAsset(a.id)
      .then(reload)
      .then(() => toast.success(`Processing “${assetName(a, locale)}” again`))
      .catch(fail);

  // --- uploads ------------------------------------------------------------
  const patchUpload = (id: string, patch: Partial<UploadItem>) =>
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));

  const uploadOne = async (
    file: File,
    folderId: string | undefined,
    itemId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    // Only a multipart upload can be stopped part way; any other is offered Cancel while it waits.
    if (!uploadsInParts(file.size) || file.type.startsWith('video/')) {
      patchUpload(itemId, { cancellable: false });
    }
    if (file.type.startsWith('video/')) {
      try {
        // Hosted video (Cloudflare Stream): adaptive playback and a poster. Filed afterwards: the
        // video upload starts on the host, not with a folder.
        const asset = await client.uploadVideo(file);
        if (folderId) await client.moveAssets([asset.id], folderId);
        return asset.id;
      } catch (e) {
        // 501: no video host bound on this deployment; store it as a plain file.
        if (!(e instanceof ApiError && e.status === 501)) throw e;
      }
    }
    if (uploadsInParts(file.size)) {
      // Past one signed PUT: in parts, each retried on its own, with the bytes stored as progress.
      // Cancellable again (a video the host refused comes here as a plain file).
      patchUpload(itemId, { cancellable: true });
      const asset = await uploadInParts(client, file, {
        ...(folderId ? { folderId } : {}),
        signal,
        onProgress: (progress) =>
          patchUpload(itemId, {
            progress,
            state: progress.retryingPart !== null ? 'retrying' : 'uploading',
          }),
      });
      await client.publishAsset(asset.id);
      return asset.id;
    }
    return (await client.uploadAsset(file, folderId ? { folderId } : {})).id;
  };

  const cancelUpload = (id: string) => {
    uploadControls.current.get(id)?.abort();
    // One still waiting ends here; one under way ends when its upload has been aborted.
    setUploads((list) =>
      list.map((u) => (u.id === id && u.state === 'queued' ? { ...u, state: 'cancelled' } : u)),
    );
  };

  const upload = async (files: readonly File[]) => {
    if (files.length === 0) return;
    // With a collection open, the files land at the library root (the folder tree isn't in view)
    // and go into the collection once uploaded.
    const into = collectionId !== null ? openCollection : undefined;
    const folderId = into ? undefined : openFolder?.id;
    setUploadInto(into ? into.name : null);
    const uploaded: string[] = [];
    const batch = files.map((file, i) => ({
      file,
      item: {
        id: `${Date.now()}-${i}-${file.name}`,
        name: file.name,
        state: 'queued',
        cancellable: true,
      } as UploadItem,
    }));
    for (const { item } of batch) uploadControls.current.set(item.id, new AbortController());
    setUploads((list) => [...list.filter((u) => u.state !== 'done'), ...batch.map((b) => b.item)]);
    const outcome = new Map<string, UploadItem>();
    let next = 0;
    const lane = async () => {
      while (next < batch.length) {
        const { file, item } = batch[next++] as (typeof batch)[number];
        const signal = (uploadControls.current.get(item.id) ?? new AbortController()).signal;
        if (signal.aborted) {
          outcome.set(item.id, { ...item, state: 'cancelled' });
          continue;
        }
        patchUpload(item.id, { state: 'uploading' });
        try {
          uploaded.push(await uploadOne(file, folderId, item.id, signal));
          patchUpload(item.id, { state: 'done' });
          outcome.set(item.id, { ...item, state: 'done' });
        } catch (e) {
          if (signal.aborted) {
            patchUpload(item.id, { state: 'cancelled' });
            outcome.set(item.id, { ...item, state: 'cancelled' });
          } else {
            patchUpload(item.id, { state: 'failed', error: message(e) });
            outcome.set(item.id, { ...item, state: 'failed', error: message(e) });
          }
        } finally {
          uploadControls.current.delete(item.id);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, batch.length) }, lane));
    if (fileRef.current) fileRef.current.value = '';
    // The batch's end is said once, in a toast, beside the list's own live summary.
    const finished = [...outcome.values()];
    const summary = uploadSummary(finished);
    if (finished.some((u) => u.state === 'failed')) toast.error(summary);
    else toast.success(summary);
    if (into && uploaded.length > 0) await addUploadsTo(into, uploaded);
    await reload();
  };

  /** Puts what a batch uploaded into the collection that was open, in turns the API takes. */
  const addUploadsTo = async (into: AssetCollection, ids: readonly string[]) => {
    try {
      let added = 0;
      let skipped = 0;
      for (const part of chunked(ids, MAX_COLLECTION_CHANGE)) {
        const r = await client.addToAssetCollection(into.id, part);
        added += r.added;
        skipped += r.skipped.length;
      }
      toast.success(addedSummary(into.name, { requested: ids.length, added, skipped }));
    } catch (e) {
      toast.error(
        `Uploaded, but not added to “${into.name}”: ${message(e)}. They are at the library root.`,
      );
    } finally {
      void invalidate(['asset-collections'], ['assets', 'collection', into.id]);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload([...e.dataTransfer.files]);
  };
  const onDragOver = (e: DragEvent) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };

  // --- one asset ----------------------------------------------------------
  const publish = (a: Asset) => void client.publishAsset(a.id).then(reload).catch(fail);

  // Unpublish is only offered on a published asset, so republishing restores
  // exactly what was live: an Undo, not an up-front confirm (as for entries).
  const unpublish = (asset: Asset) =>
    void client
      .unpublishAsset(asset.id)
      .then(reload)
      .then(() =>
        toast.success(`Unpublished “${assetName(asset, locale)}”`, {
          action: {
            label: 'Undo',
            onAction: () =>
              void client
                .publishAsset(asset.id)
                .then(reload)
                .then(() => toast.success(`Republished “${assetName(asset, locale)}”`))
                .catch(fail),
          },
        }),
      )
      .catch(fail);

  // Archive is undone by restoring, so it too is an Undo rather than a confirm.
  const archive = (asset: Asset) =>
    void client
      .archiveAsset(asset.id)
      .then(reload)
      .then(() =>
        toast.success(`Archived “${assetName(asset, locale)}”`, {
          action: {
            label: 'Undo',
            onAction: () => void client.restoreAsset(asset.id).then(reload).catch(fail),
          },
        }),
      )
      .catch(fail);

  const restore = (asset: Asset) =>
    void client
      .restoreAsset(asset.id)
      .then(reload)
      .then(() => toast.success(`Restored “${assetName(asset, locale)}” as a draft`))
      .catch(fail);

  const remove = async (asset: Asset) => {
    try {
      await client.deleteAsset(asset.id);
      setSelected((s) => {
        const next = new Set(s);
        next.delete(asset.id);
        return next;
      });
      toast.success(`Deleted “${assetName(asset, locale)}”`);
      await reload();
    } catch (e) {
      const used = assetUsageOf(e);
      if (!used) throw e;
      refusedInUse.current = { asset, ...used };
    }
  };
  // Shown once the confirm has gone: the notice takes focus, which the dialog would hold on to.
  const showInUse = (event: Event) => {
    if (!refusedInUse.current) return;
    event.preventDefault();
    setInUse(refusedInUse.current);
    refusedInUse.current = null;
  };

  // --- selection and bulk ---------------------------------------------------
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allSelected = assets.length > 0 && assets.every((a) => selected.has(a.id));
  const ids = [...selected];

  // A failure never stops the rest. The ones that failed stay selected and are named in place, as
  // the entries list names its bulk failures, so they can be tried again.
  const bulk = async (verb: string, act: (id: string) => Promise<unknown>) => {
    setBulkBusy(true);
    setBulkFailures(null);
    try {
      const outcome = await runBulk(ids, act);
      (outcome.failed ? toast.error : toast.success)(bulkSummary(verb, outcome));
      const failures = outcome.failures ?? [];
      setSelected(new Set(failures.map((f) => f.id)));
      if (failures.length > 0) {
        const byId = new Map(assets.map((a) => [a.id, a]));
        setBulkFailures({
          verb,
          items: failures.map((f) => {
            const a = byId.get(f.id);
            return { name: a ? assetName(a, locale) : f.id, error: f.error };
          }),
        });
      }
      await reload();
    } finally {
      setBulkBusy(false);
    }
  };

  // Past ASSET_BULK_JOB_THRESHOLD the action runs as a job on the server; this tab only watches.
  const startJob = async (request: AssetBulkRequest) => {
    setBulkBusy(true);
    setBulkFailures(null);
    try {
      const job = await client.startAssetBulkJob(request);
      setBulkJob({ action: request.action, job });
    } catch (e) {
      fail(e);
      setBulkBusy(false);
    }
  };
  // Polls the running job, as an import job is polled, and stops once it has finished.
  const runningJob = bulkJob?.job.status === 'running' ? bulkJob.job.id : null;
  useEffect(() => {
    if (!runningJob) return;
    const timer = setInterval(() => {
      client
        .getBulkJob(runningJob)
        // Never backwards: a poll that left before a Stop came back must not undo the stop (the
        // card would run again, and the finish below would run twice).
        .then((job) =>
          setBulkJob((current) =>
            current?.job.id === job.id && current.job.status === 'running'
              ? { ...current, job }
              : current,
          ),
        )
        .catch((e) => {
          // A refusal (the session ended, the job is gone) won't pass by itself: stop watching
          // and free the bar, rather than keep it disabled until a reload. Anything else is
          // transient, and the next tick tries again.
          if (!(e instanceof ApiError) || e.status < 400 || e.status >= 500) return;
          setBulkJob(null);
          setBulkBusy(false);
          toast.error(
            `Stopped following the bulk job: ${apiErrorMessage(e)}. It goes on running; reload to see what it did.`,
          );
        });
    }, BULK_JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [runningJob, client]);
  // Stopping it: the server's answer is the job as it ended, which ends the polling and runs the
  // finish below (the toast, the reload, the report) as any end does.
  const [cancellingJob, setCancellingJob] = useState(false);
  const cancelJob = async (id: string) => {
    setCancellingJob(true);
    try {
      const job = await client.cancelBulkJob(id);
      setBulkJob((current) => (current?.job.id === id ? { ...current, job } : current));
    } catch (e) {
      toast.error(`The job wasn’t stopped: ${apiErrorMessage(e)}`);
    } finally {
      setCancellingJob(false);
    }
  };
  // Once it has finished: say so, keep what failed selected and name it from the job's report.
  const finishedJob = bulkJob && bulkJob.job.status !== 'running' ? bulkJob : null;
  // Once per finished job (polling stops, so the object no longer changes): the toast and the
  // report are read when it finishes, not on every render.
  useEffect(() => {
    if (!finishedJob) return;
    const { action, job } = finishedJob;
    const verb = BULK_VERBS[action].done;
    setBulkBusy(false);
    // A stopped job left some assets as they were: the selection stays, to run it again.
    if (job.failed === 0 && job.status !== 'cancelled') setSelected(new Set());
    const said = bulkSummary(verb, jobOutcome(job));
    (job.failed ? toast.error : toast.success)(
      job.status === 'cancelled' ? `Stopped: ${said}` : said,
    );
    void reload();
    if (job.failed === 0) return;
    client
      .getBulkJobReport(job.id)
      .then((report) => {
        // A batch that failed as a whole names no asset: the library's own names fill in.
        const known = new Map(assets.map((a) => [a.id, assetName(a, locale)]));
        const failures = jobFailures(report, known);
        setSelected(new Set(failures.map((f) => f.id)));
        setBulkFailures({ verb, items: failures });
      })
      .catch(() =>
        // A role limited to some content types can't read the report: the counts stand alone.
        setBulkFailures({ verb, items: [], unnamed: job.failed }),
      );
  }, [finishedJob]);

  /** Runs `action` over the selection: in this tab for a few, as a job past the threshold. */
  const act = (action: 'publish' | 'unpublish' | 'archive') => {
    if (runsAsJob(ids.length)) return void startJob({ action, ids });
    const verb = BULK_VERBS[action].done;
    if (action === 'publish') return void bulk(verb, (id) => client.publishAsset(id));
    if (action === 'unpublish') return void bulk(verb, (id) => client.unpublishAsset(id));
    return void bulk(verb, (id) => client.archiveAsset(id));
  };

  // Tagging always runs as a job, whatever the count: the server adds or removes the tag on each
  // asset's current tags, where a loop here would write back tags read when the page loaded.
  const tagSelected = (tagId: string, change: 'add' | 'remove') =>
    void startJob({
      action: 'tag',
      ids,
      ...(change === 'add' ? { addTags: [tagId] } : { removeTags: [tagId] }),
    });

  const moveSelected = async (folderId: string | null) => {
    if (runsAsJob(ids.length)) return startJob({ action: 'move', ids, folderId });
    setBulkBusy(true);
    try {
      const { moved } = await client.moveAssets(ids, folderId);
      const where = folderId ? folders.find((f) => f.id === folderId)?.name : undefined;
      toast.success(
        `Moved ${moved} ${moved === 1 ? 'asset' : 'assets'} ${where ? `to “${where}”` : 'out of their folders'}`,
      );
      setSelected(new Set());
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBulkBusy(false);
    }
  };

  // --- folders --------------------------------------------------------------
  const createFolder = async (name: string, parentId?: string) => {
    try {
      const created = await client.createAssetFolder({ name, ...(parentId ? { parentId } : {}) });
      await reloadFolders();
      changeFolder({ kind: 'folder', id: created.id });
      return created;
    } catch (e) {
      fail(
        e instanceof ApiError && e.status === 409 ? `A folder named “${name}” is already here` : e,
      );
      return undefined;
    }
  };
  const renameFolder = async (f: AssetFolder, name: string) => {
    try {
      await client.updateAssetFolder(f.id, { name });
      await reloadFolders();
    } catch (e) {
      fail(
        e instanceof ApiError && e.status === 409 ? `A folder named “${name}” is already here` : e,
      );
    }
  };
  const deleteFolder = async (f: AssetFolder) => {
    try {
      await client.deleteAssetFolder(f.id);
      changeFolder({ kind: 'all' });
      await reloadFolders();
      toast.success(`Deleted folder “${f.name}”`);
    } catch (e) {
      fail(
        e instanceof ApiError && e.status === 409
          ? `“${f.name}” isn’t empty: move or delete what is in it first`
          : e,
      );
    }
  };

  // --- collections ----------------------------------------------------------
  const showCollection = (id: string | null) => {
    setCollectionId(id);
    setSelected(new Set());
    setBulkFailures(null);
  };
  const createCollection = async (values: { name: string; description: string }) => {
    try {
      const created = await client.createAssetCollection({
        name: values.name,
        ...(values.description ? { description: values.description } : {}),
      });
      await reloadCollections();
      setCreatedCollection(created.id);
      showCollection(created.id);
      toast.success(`Created collection “${created.name}”`);
      return created;
    } catch (e) {
      fail(e);
      return undefined;
    }
  };
  // Up to MAX_COLLECTION_CHANGE ids a request: a bigger selection goes in turns.
  const addSelectedTo = async (id: string) => {
    const target = collections.find((c) => c.id === id);
    setBulkBusy(true);
    try {
      let added = 0;
      let skipped = 0;
      for (const part of chunked(ids, MAX_COLLECTION_CHANGE)) {
        const r = await client.addToAssetCollection(id, part);
        added += r.added;
        skipped += r.skipped.length;
      }
      toast.success(
        addedSummary(target?.name ?? 'the collection', { requested: ids.length, added, skipped }),
      );
      setSelected(new Set());
    } catch (e) {
      fail(e);
    } finally {
      setBulkBusy(false);
      void invalidate(['asset-collections'], ['assets', 'collection', id]);
    }
  };

  // --- rendering ----------------------------------------------------------
  const pick = () => fileRef.current?.click();

  /** The actions on one asset, the same in the grid and the list. */
  const actions = (a: Asset, name: string) => (
    <div className="flex items-center gap-0.5">
      {a.status === 'archived' ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Restore “${name}”`}
          onClick={() => restore(a)}
        >
          <ArchiveRestore aria-hidden="true" />
          Restore
        </Button>
      ) : a.status === 'published' ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Unpublish “${name}”`}
          onClick={() => unpublish(a)}
        >
          Unpublish
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Publish “${name}”`}
          onClick={() => publish(a)}
        >
          Publish
        </Button>
      )}
      {a.status === 'archived' ? (
        <ConfirmDialog
          message={`Delete “${name}”?`}
          note="Its files go too. This can’t be undone."
          confirmLabel="Delete asset"
          onConfirm={() => remove(a)}
          onCloseAutoFocus={showInUse}
        >
          {(ask) => (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Delete “${name}”`}
              onClick={ask}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          )}
        </ConfirmDialog>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Archive “${name}”`}
          onClick={() => archive(a)}
        >
          <Archive aria-hidden="true" />
        </Button>
      )}
    </div>
  );

  const badges = (a: Asset) => {
    const video = a.file.video;
    const rights = rightsState(a.rights, now);
    return (
      <div className="flex flex-wrap items-center gap-1">
        <StatusBadge status={a.status} />
        {rights && (
          <StatusBadge
            status={RIGHTS_BADGE[rights.state].status}
            label={RIGHTS_BADGE[rights.state].label}
          />
        )}
        {video && (
          <StatusBadge
            status={video.status === 'ready' ? 'completed' : video.status}
            label={VIDEO_STATUS_LABEL[video.status] ?? humanize(video.status)}
          />
        )}
        <AssetIngestBadges
          asset={a}
          name={assetName(a, locale)}
          onOpenOriginal={openOriginal}
          onRetry={retryIngest}
        />
      </div>
    );
  };

  const selectBox = (a: Asset, name: string) => (
    <Checkbox
      aria-label={`Select “${name}”`}
      checked={selected.has(a.id)}
      onCheckedChange={(on) => toggle(a.id, on === true)}
    />
  );

  const grid = (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">
      {assets.map((a) => {
        const name = assetName(a, locale);
        return (
          <li key={a.id} className="flex">
            <Card
              size="sm"
              // A Ledger board card: hover and the open button's focus tint the card muted; the
              // card's own controls sit beside the open button, never inside it.
              className={cn(
                'relative w-full gap-2 p-2 transition-[background-color] hover:bg-muted/60 has-[[data-open-asset]:focus-visible]:bg-muted/60 has-[[data-open-asset]:focus-visible]:outline-2 has-[[data-open-asset]:focus-visible]:outline-offset-2 has-[[data-open-asset]:focus-visible]:outline-brand',
                selected.has(a.id) && 'bg-muted/60 ring-2 ring-brand',
              )}
            >
              <div className="absolute top-3 left-3 z-10 rounded-[5px] bg-background">
                {selectBox(a, name)}
              </div>
              <AssetPreview
                asset={a}
                alt={String(a.metadata.altText?.[locale] ?? a.file.fileName)}
                className="h-28 w-full"
              />
              {/* The name is the card's control, stretched over it; its visible text is only the
                  name, which its label carries (WCAG 2.5.3). */}
              <button
                type="button"
                data-open-asset=""
                onClick={() => setOpen(a)}
                aria-label={`Open “${name}”`}
                className="truncate text-left font-medium text-sm outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-['']"
              >
                {name}
              </button>
              <div className="relative z-10 flex flex-wrap items-center justify-between gap-1">
                {badges(a)}
                {actions(a, name)}
              </div>
            </Card>
          </li>
        );
      })}
      {Array.from({ length: pending }, (_, i) => (
        <li key={`pending-${i}`} className="flex" aria-hidden="true">
          <AssetCardSkeleton index={i} />
        </li>
      ))}
    </ul>
  );

  // On a phone each row lays itself out as the entries rows do: the checkbox beside the name, the
  // type, size and status under it, the actions at the end. The cells keep their table roles.
  const ROW_STACK =
    'max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:items-center max-md:gap-x-2 max-md:gap-y-1.5 max-md:px-3 max-md:py-2';
  const CELL_STACK = 'max-md:block max-md:p-0';
  const phoneLabel = (label: string) => (
    <span aria-hidden="true" className="text-muted-foreground md:hidden">
      {label}{' '}
    </span>
  );
  const list = (
    <div className="card overflow-clip">
      <Table caption="Assets" stack="rows" sticky className="max-md:block">
        <TableHead>
          <Tr>
            <Th className="w-8">
              <Checkbox
                aria-label="Select all shown"
                checked={allSelected}
                disabled={assets.length === 0}
                onCheckedChange={(on) =>
                  setSelected(on === true ? new Set(assets.map((a) => a.id)) : new Set())
                }
              />
            </Th>
            <Th>Name</Th>
            <Th>Type</Th>
            <Th numeric>Size</Th>
            <Th>Status</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </Tr>
        </TableHead>
        <TableBody className="max-md:block">
          {assets.map((a) => {
            const name = assetName(a, locale);
            return (
              <Tr key={a.id} className={ROW_STACK}>
                <Td label="Select" className={`${CELL_STACK} max-md:row-span-2 max-md:self-start`}>
                  {selectBox(a, name)}
                </Td>
                <Td label="Name" className={`${CELL_STACK} max-md:col-span-2`}>
                  {/* The thumbnail beside the button, not in it: the button's visible text is the
                      name alone (a fallback tile would add the file name to it). */}
                  <div className="flex min-w-0 items-center gap-2">
                    <AssetPreview asset={a} alt="" className="size-8 shrink-0 rounded-lg" />
                    <button
                      type="button"
                      onClick={() => setOpen(a)}
                      aria-label={`Open “${name}”`}
                      className="hit-area min-w-0 truncate rounded-full text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {name}
                    </button>
                  </div>
                </Td>
                <Td
                  label="Type"
                  className={`font-mono text-xs ${CELL_STACK} max-md:col-start-2 max-md:truncate`}
                >
                  {phoneLabel('Type')}
                  {a.file.contentType}
                </Td>
                <Td label="Size" numeric className={`${CELL_STACK} max-md:text-left`}>
                  {phoneLabel('Size')}
                  {fileSize(a.file.size)}
                </Td>
                <Td label="Status" className={`${CELL_STACK} max-md:col-start-2`}>
                  {badges(a)}
                </Td>
                <Td label="Actions" className={`text-right ${CELL_STACK}`}>
                  {actions(a, name)}
                </Td>
              </Tr>
            );
          })}
          {Array.from({ length: pending }, (_, i) => (
            <AssetRowSkeleton
              key={`pending-${i}`}
              index={i}
              rowClassName={ROW_STACK}
              cellClassName={CELL_STACK}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );

  const filtered = activeFilterCount(filters) > 0 || folder.kind !== 'all';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Assets"
        subtitle="Images, video, audio and documents you can link from entries."
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Upload asset files"
          onChange={(e) => void upload([...(e.target.files ?? [])])}
        />
        <Button type="button" size="sm" onClick={pick}>
          <Upload aria-hidden="true" />
          {openCollection && collectionId !== null
            ? `Upload to “${openCollection.name}”`
            : openFolder
              ? `Upload to “${openFolder.name}”`
              : 'Upload'}
        </Button>
      </PageHeader>

      <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4 md:space-y-6">
          <AssetFolderTree
            folders={folders}
            value={folder}
            inactive={collectionId !== null}
            onChange={changeFolder}
            onCreate={createFolder}
            onRename={renameFolder}
            onDelete={deleteFolder}
          />
          <AssetCollectionList
            collections={collections}
            value={collectionId}
            onOpen={showCollection}
            onCreate={createCollection}
          />
        </div>

        {collectionId !== null ? (
          <div className="min-w-0 space-y-4">
            <AssetUploadList
              items={uploads}
              onDismiss={() => setUploads([])}
              onCancel={cancelUpload}
              {...(uploadInto ? { into: uploadInto } : {})}
            />
            {openCollection ? (
              <AssetCollectionView
                key={openCollection.id}
                collection={openCollection}
                locale={locale}
                focusOnOpen={createdCollection === openCollection.id}
                onOpenAsset={setOpen}
                onChanged={() => void reloadCollections()}
                onDeleted={() => {
                  showCollection(null);
                  void reloadCollections();
                }}
                zip={collectionZip}
              />
            ) : (
              <LoadingStatus>Loading the collection…</LoadingStatus>
            )}
          </div>
        ) : (
          // The drop target. Picking files with Upload is the keyboard's way to the same place.
          <section
            aria-label="Asset library"
            onDragOver={onDragOver}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={onDrop}
            className={cn(
              'min-w-0 space-y-4 rounded-2xl transition-[box-shadow]',
              dragging && 'ring-2 ring-foreground/30 ring-offset-4 ring-offset-background',
            )}
          >
            <AssetSearchBox value={searchText} onChange={changeSearch} />
            <AssetFilterBar
              value={filters}
              onChange={changeFilters}
              tags={tags}
              view={view}
              onViewChange={setView}
            />
            {searching && chips && (
              <AssetFacetChips groups={chips} isActive={chipActive} onToggle={toggleChip} />
            )}
            {/* Always mounted, so the first result is announced too; empty (and hidden) at rest. */}
            <p
              className={cn('text-ui text-muted-foreground', !searchSummary && 'sr-only')}
              aria-live="polite"
              aria-busy={searchBusy || undefined}
            >
              {searchSummary}
            </p>
            {dragging && (
              <p className="caption" aria-live="polite">
                Drop files to upload {openFolder ? `to “${openFolder.name}”` : 'here'}
              </p>
            )}
            <AssetUploadList
              items={uploads}
              onDismiss={() => setUploads([])}
              onCancel={cancelUpload}
              {...(uploadInto ? { into: uploadInto } : {})}
            />
            {bulkFailures && (
              <Alert variant="destructive">
                <AlertTitle>
                  {plural(bulkFailures.unnamed ?? bulkFailures.items.length, 'asset')} not{' '}
                  {bulkFailures.verb.toLowerCase()}
                </AlertTitle>
                <AlertDescription>
                  <p>
                    {bulkFailures.unnamed !== undefined
                      ? 'Your role can’t read the job’s report, so they can’t be named here.'
                      : 'They are still selected, to try again.'}
                  </p>
                  <ul className="space-y-0.5">
                    {bulkFailures.items.map((f, i) => (
                      <li key={i}>
                        <span className="font-medium">{f.name}</span>
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
            {inUse && (
              <AssetInUseNotice
                name={assetName(inUse.asset, locale)}
                usage={inUse.usage}
                total={inUse.total}
                onDismiss={() => setInUse(null)}
              />
            )}
            {bulkJob && (
              <AssetBulkJobProgress
                action={bulkJob.action}
                job={bulkJob.job}
                onDismiss={() => setBulkJob(null)}
                onCancel={() => void cancelJob(bulkJob.job.id)}
                cancelling={cancellingJob}
              />
            )}
            {zip.zip && (
              <AssetZipProgress
                zip={zip.zip}
                onRefresh={() => void zip.refresh()}
                onDismiss={zip.dismiss}
              />
            )}
            {/* A collection's zip, still followed (and downloadable) back in the library. */}
            {collectionZip.zip && (
              <AssetZipProgress
                zip={collectionZip.zip}
                onRefresh={() => void collectionZip.refresh()}
                onDismiss={collectionZip.dismiss}
              />
            )}
            <AssetBulkBar
              count={selected.size}
              folders={folders}
              tags={tags}
              busy={bulkBusy}
              onMove={(f) => void moveSelected(f)}
              onTag={tagSelected}
              onPublish={() => act('publish')}
              onUnpublish={() => act('unpublish')}
              onArchive={() => act('archive')}
              collections={collections}
              onAddToCollection={(id) => void addSelectedTo(id)}
              onZip={() => void zip.start({ assetIds: ids })}
              zipStarting={zip.starting}
              onClear={() => {
                setSelected(new Set());
                setBulkFailures(null);
              }}
            />
            {loading ? (
              <>
                {/* A search says so in its summary line, above. */}
                {searching ? null : <LoadingStatus>Loading assets…</LoadingStatus>}
                {view === 'grid' ? grid : list}
              </>
            ) : loadError && assets.length === 0 ? (
              // A failed load is said as one, never as an empty library.
              <Alert variant="destructive">
                <AlertTitle>
                  {searching ? 'The search didn’t finish' : 'The assets didn’t load'}
                </AlertTitle>
                <AlertDescription>
                  <p>{message(loadError)}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => void (searching ? search.refetch() : pages.refetch())}
                  >
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : assets.length === 0 ? (
              searching ? (
                <EmptyState
                  icon={ImageIcon}
                  title="No matches"
                  description="Nothing in the library matches this search here. Try other words, or clear the filters."
                />
              ) : filtered ? (
                <EmptyState
                  icon={ImageIcon}
                  title="Nothing here"
                  description="No assets match this folder and these filters. Drop files here to add some."
                />
              ) : (
                <EmptyState
                  icon={ImageIcon}
                  title="No assets yet"
                  description="Upload or drop images, video and files to start your library."
                >
                  <Button type="button" onClick={pick}>
                    Upload
                  </Button>
                </EmptyState>
              )
            ) : (
              <Refreshing busy={refreshing}>{view === 'grid' ? grid : list}</Refreshing>
            )}
            {!searching && pages.hasNextPage && (
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pages.isFetchingNextPage}
                  aria-busy={pages.isFetchingNextPage || undefined}
                  onClick={() => void pages.fetchNextPage()}
                >
                  Load more
                </Button>
                {pages.isFetchingNextPage ? (
                  <LoadingStatus>Loading more assets…</LoadingStatus>
                ) : null}
              </div>
            )}
          </section>
        )}
      </div>

      <AssetDetailSheet
        asset={open}
        locale={locale}
        open={open !== null}
        onOpenChange={(o) => !o && setOpen(null)}
        onSaved={() => void reload()}
        onAssetChange={(next) => {
          setOpen(next);
          void reload();
        }}
        onOpenAsset={openOriginal}
      />
    </div>
  );
}

/** Name lengths for skeleton cards and rows, so a run of them reads as different file names. */
const NAME_WIDTHS = ['72%', '54%', '86%', '61%', '47%', '78%'];

/** A board card still on its way: the real card's padding, preview, name line and footer. */
function AssetCardSkeleton({ index }: { index: number }) {
  return (
    <Card size="sm" className="relative w-full gap-2 p-2">
      <Skeleton className="h-28 w-full" />
      <span className="font-medium text-sm">
        <SkeletonText width={NAME_WIDTHS[index % NAME_WIDTHS.length]} />
      </span>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <SkeletonPill className={index % 3 === 2 ? 'w-[5.5rem]' : 'w-[4.5rem]'} />
        <AssetActionsSkeleton />
      </div>
    </Card>
  );
}

/** A list row still on its way, laid out by the real row's classes (it stacks the same). */
function AssetRowSkeleton({
  index,
  rowClassName,
  cellClassName,
}: {
  index: number;
  rowClassName: string;
  cellClassName: string;
}) {
  return (
    <Tr aria-hidden="true" className={rowClassName}>
      <Td className={`${cellClassName} max-md:row-span-2 max-md:self-start`}>
        <Skeleton className="size-4 rounded-[4px]" />
      </Td>
      <Td className={`${cellClassName} max-md:col-span-2`}>
        <div className="flex min-w-0 items-center gap-2">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <SkeletonText className="font-medium" width={NAME_WIDTHS[index % NAME_WIDTHS.length]} />
        </div>
      </Td>
      <Td className={`text-xs ${cellClassName} max-md:col-start-2`}>
        <SkeletonText width="6.5rem" />
      </Td>
      <Td numeric className={`text-xs ${cellClassName} max-md:text-left`}>
        <SkeletonText width="3rem" className="items-end max-md:items-start" />
      </Td>
      <Td className={`${cellClassName} max-md:col-start-2`}>
        <SkeletonPill className="w-[4.5rem]" />
      </Td>
      <Td className={`text-right ${cellClassName}`}>
        <AssetActionsSkeleton className="ml-auto" />
      </Td>
    </Tr>
  );
}

/** The ghost actions (Publish or Unpublish, Archive or Delete) as they sit at rest: a label, two icons. */
function AssetActionsSkeleton({ className }: { className?: string }) {
  return (
    <span className={cn('flex h-6 w-[8.25rem] items-center gap-2.5 px-2.5 text-xs', className)}>
      <SkeletonText width="3.5rem" className="w-auto" />
      <Skeleton className="size-3 rounded-[3px]" />
      <Skeleton className="size-3 rounded-[3px]" />
    </span>
  );
}
