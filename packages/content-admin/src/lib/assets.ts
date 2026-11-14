import {
  type Asset,
  type AssetFolder,
  type AssetKind,
  type AssetRights,
  rightsExpireSoon,
} from '@commerceworker/domain';
import type { BulkOutcome } from './bulk-jobs';
import { plural } from './format';
import {
  ApiError,
  type AssetFacets,
  type AssetListQuery,
  type AssetSearchQuery,
  type AssetZip,
  apiErrorMessage,
  type ManagementClient,
  UploadPartError,
} from './management';

/** Where the library is looking: everything, the assets in no folder, or one folder. */
export type FolderSelection =
  | { readonly kind: 'all' }
  | { readonly kind: 'root' }
  | {
      readonly kind: 'folder';
      readonly id: string;
    };

export const ALL_FOLDERS: FolderSelection = { kind: 'all' };

/** The library's filter bar, as the screen holds it (the API query is derived from it). */
export interface AssetFilterState {
  readonly kind?: AssetKind;
  readonly status?: 'draft' | 'published' | 'archived' | 'all';
  readonly tag?: string;
  /** One of {@link ASSET_SORTS}' values. */
  readonly sort?: AssetSortChoice;
}

export type AssetSortChoice =
  | 'updated-desc'
  | 'updated-asc'
  | 'created-desc'
  | 'size-desc'
  | 'size-asc';

export const ASSET_SORTS: readonly { value: AssetSortChoice; label: string }[] = [
  { value: 'updated-desc', label: 'Recently changed' },
  { value: 'updated-asc', label: 'Least recently changed' },
  { value: 'created-desc', label: 'Newest' },
  { value: 'size-desc', label: 'Largest' },
  { value: 'size-asc', label: 'Smallest' },
];

export const KIND_LABELS: Record<AssetKind, string> = {
  image: 'Images',
  video: 'Video',
  audio: 'Audio',
  document: 'Documents',
  other: 'Other files',
};

const SORT_QUERY: Record<AssetSortChoice, Pick<AssetListQuery, 'sort' | 'order'>> = {
  'updated-desc': {},
  'updated-asc': { sort: 'updatedAt', order: 'asc' },
  'created-desc': { sort: 'createdAt', order: 'desc' },
  'size-desc': { sort: 'size', order: 'desc' },
  'size-asc': { sort: 'size', order: 'asc' },
};

/** A page of the library this size; the API allows up to 100. */
export const ASSET_PAGE_SIZE = 50;

/** The API query for what the screen shows: the folder, then the filter bar. */
export function assetLibraryQuery(
  folder: FolderSelection,
  filters: AssetFilterState,
): AssetListQuery {
  return {
    limit: ASSET_PAGE_SIZE,
    ...(folder.kind === 'root' ? { folder: 'root' } : {}),
    ...(folder.kind === 'folder' ? { folder: folder.id } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.tag ? { tag: filters.tag } : {}),
    ...(filters.sort ? SORT_QUERY[filters.sort] : {}),
  };
}

/** How many filters are narrowing the list (the sort is not one). */
export const activeFilterCount = (f: AssetFilterState): number =>
  [f.kind, f.status, f.tag].filter(Boolean).length;

/** A folder as the tree draws it: its depth under the root (0 at the top). */
export interface FolderRow {
  readonly folder: AssetFolder;
  readonly depth: number;
}

/**
 * The folders in tree order with their depth. The API lists them in path order, which already puts
 * a parent before its children; sorting by name within a parent is done here.
 */
export function folderRows(folders: readonly AssetFolder[]): FolderRow[] {
  const children = new Map<string, AssetFolder[]>();
  for (const f of folders) {
    const key = f.parentId ?? '';
    children.set(key, [...(children.get(key) ?? []), f]);
  }
  const out: FolderRow[] = [];
  const walk = (parent: string, depth: number) => {
    const list = [...(children.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of list) {
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

/** A folder's name with its ancestors, `Brand / Logos`, for a move menu. */
export function folderLabel(folder: AssetFolder, folders: readonly AssetFolder[]): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const names = folder.path
    .split('/')
    .filter(Boolean)
    .map((id) => byId.get(id)?.name ?? '…');
  return names.join(' / ');
}

/** The name an editor knows an asset by: its title in the locale, else its file name. */
export function assetName(asset: Asset, locale: string): string {
  return String(asset.title?.[locale] ?? asset.file.fileName);
}

/** `1.2 MB`, for the list view's size column. */
export function fileSize(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
}

/**
 * Runs `act` over every id, a few at a time, and counts what worked: one failure never stops the
 * rest, and the caller reports the tally.
 */
export async function runBulk(
  ids: readonly string[],
  act: (id: string) => Promise<unknown>,
  concurrency = 4,
): Promise<BulkOutcome> {
  let done = 0;
  const failures: { id: string; error: string }[] = [];
  let next = 0;
  const lane = async () => {
    while (next < ids.length) {
      const id = ids[next++] as string;
      try {
        await act(id);
        done += 1;
      } catch (e) {
        failures.push({ id, error: apiErrorMessage(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, lane));
  return { done, failed: failures.length, failures };
}

/** The search query for what the screen shows: the text, the folder, then the filter bar. */
export function assetSearchQuery(
  q: string,
  folder: FolderSelection,
  filters: AssetFilterState,
): AssetSearchQuery {
  return {
    q,
    limit: 100,
    ...(folder.kind === 'root' ? { folder: 'root' } : {}),
    ...(folder.kind === 'folder' ? { folder: folder.id } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.tag ? { tag: filters.tag } : {}),
  };
}

/** One facet chip: what it narrows to, how it is named, how many matches it has. */
export interface FacetChip {
  readonly facet: 'kind' | 'tag' | 'folder';
  /** The kind, tag id or folder id (`root` for no folder). */
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

/**
 * The chips a search's facets make, most matches first within each facet: kinds by their label,
 * tags and folders by name (one no longer known is left out rather than shown as an id).
 */
export function facetChips(
  facets: AssetFacets,
  tags: readonly { id: string; name: string }[],
  folders: readonly AssetFolder[],
): { kind: FacetChip[]; tag: FacetChip[]; folder: FacetChip[] } {
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const chips = (
    facet: FacetChip['facet'],
    counts: Readonly<Record<string, number>>,
    label: (value: string) => string | undefined,
  ) =>
    Object.entries(counts)
      .flatMap(([value, count]) => {
        const name = label(value);
        return name && count > 0 ? [{ facet, value, label: name, count }] : [];
      })
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return {
    kind: chips('kind', facets.kind, (k) => KIND_LABELS[k as AssetKind]),
    tag: chips('tag', facets.tag, (id) => tagName.get(id)),
    folder: chips('folder', facets.folder, (id) =>
      id === 'root' ? 'Not in a folder' : folderName.get(id),
    ),
  };
}

/** What a card says about ingest: running, failed (with why), or nothing once it is done. */
export function ingestState(
  asset: Pick<Asset, 'ingestStatus' | 'ingestError'>,
): { readonly state: 'processing' | 'failed'; readonly error?: string } | null {
  if (asset.ingestStatus === 'pending' || asset.ingestStatus === 'processing') {
    return { state: 'processing' };
  }
  if (asset.ingestStatus === 'error') {
    return { state: 'failed', ...(asset.ingestError ? { error: asset.ingestError } : {}) };
  }
  return null;
}

// --- bulk jobs ------------------------------------------------------------------

/**
 * Past this many assets a bulk action runs as a job on the server (`POST …/assets/bulk`) rather
 * than as a loop of requests from this tab. A page of the library is {@link ASSET_PAGE_SIZE}, so
 * this is a selection bigger than one page shows: the loop would keep the tab busy for minutes
 * and stop where it was if the tab closed, while a job keeps going and names what failed.
 */
export const ASSET_BULK_JOB_THRESHOLD = 50;

/** Whether acting on `count` assets runs as a job. */
export const runsAsJob = (count: number): boolean => count > ASSET_BULK_JOB_THRESHOLD;

export type AssetBulkAction = 'move' | 'tag' | 'publish' | 'unpublish' | 'archive';

/** A bulk action's words, done ("Published") and under way ("Publishing"). */
export const BULK_VERBS: Record<
  AssetBulkAction,
  { readonly done: string; readonly doing: string }
> = {
  move: { done: 'Moved', doing: 'Moving' },
  tag: { done: 'Tagged', doing: 'Tagging' },
  publish: { done: 'Published', doing: 'Publishing' },
  unpublish: { done: 'Unpublished', doing: 'Unpublishing' },
  archive: { done: 'Archived', doing: 'Archiving' },
};

// --- usage rights ---------------------------------------------------------------

/**
 * "Expires soon" is a week out: a library looked over once a week still shows every asset before
 * its rights lapse, and a week is about the least lead time to renew a license or replace a file.
 */
export const RIGHTS_EXPIRE_SOON_MS = 7 * 24 * 60 * 60 * 1000;

/** Where an asset's rights stand at a moment; null when there is nothing to say. */
export type RightsState = {
  readonly state: 'expired' | 'expiring' | 'embargoed';
  /** The instant it expired or expires, or the embargo lifts. */
  readonly at: string;
} | null;

/**
 * Expired, expiring within {@link RIGHTS_EXPIRE_SOON_MS}, or under embargo at `now`. Expired wins:
 * an expired asset can't be delivered whatever its embargo says.
 */
export function rightsState(rights: AssetRights | undefined, now: number): RightsState {
  if (rights?.expiresAt && Date.parse(rights.expiresAt) <= now) {
    return { state: 'expired', at: rights.expiresAt };
  }
  if (rights?.embargoUntil && Date.parse(rights.embargoUntil) > now) {
    return { state: 'embargoed', at: rights.embargoUntil };
  }
  if (rights?.expiresAt && rightsExpireSoon(rights, new Date(now), RIGHTS_EXPIRE_SOON_MS)) {
    return { state: 'expiring', at: rights.expiresAt };
  }
  return null;
}

/** The status each rights state is stamped with; `format.ts` gives it its tone. */
export const RIGHTS_BADGE: Record<
  NonNullable<RightsState>['state'],
  { readonly status: string; readonly label: string }
> = {
  // Lapsed, not failed: the engine has already taken it out of Delivery.
  expired: { status: 'expired', label: 'Expired' },
  // Waits on a person: renew the license or replace the file before it lapses.
  expiring: { status: 'pending', label: 'Expires soon' },
  // On a clock: it lifts by itself.
  embargoed: { status: 'scheduled', label: 'Embargoed' },
};

/** "in 3 days", "in 5 hours", "in 20 minutes": how long from `now` until `ms`. */
export function timeUntil(ms: number, now: number): string {
  const minutes = Math.max(1, Math.round((ms - now) / 60_000));
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `in ${Math.round(hours / 24)} days`;
}

/**
 * A `datetime-local` value ("2026-01-31T09:00", on the reader's clock) as the ISO instant with a
 * zone the API takes. Empty or unreadable is null: no date.
 */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** An ISO instant as a `datetime-local` value on the reader's clock; empty for none. */
export function isoToLocalInput(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- collections ------------------------------------------------------------------

/** Most ids one add to (or remove from) a collection names; a bigger selection goes in turns. */
export const COLLECTION_CHANGE_MAX = 500;

/** `ids` in runs of at most `size`, in order. */
export function chunked<T>(ids: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Every page a cursor-paged list has, followed to its end (`max` pages at most, so a runaway
 * cursor can't keep the tab busy).
 */
export async function allPages<T>(
  page: (
    cursor?: string,
  ) => Promise<{ readonly items: readonly T[]; readonly nextCursor?: string }>,
  max = 20,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < max; i++) {
    const p = await page(cursor);
    out.push(...p.items);
    if (!p.nextCursor) break;
    cursor = p.nextCursor;
  }
  return out;
}

/**
 * "Added 3 assets to “Launch”", with what didn't go in: those already in it, and those the API
 * didn't find (deleted since the page loaded).
 */
export function addedSummary(
  collection: string,
  outcome: { readonly requested: number; readonly added: number; readonly skipped: number },
): string {
  const already = outcome.requested - outcome.added - outcome.skipped;
  const head = `Added ${outcome.added} ${outcome.added === 1 ? 'asset' : 'assets'} to “${collection}”`;
  const notes = [
    already > 0 ? `${already} already in it` : '',
    outcome.skipped > 0 ? `${outcome.skipped} no longer in the library` : '',
  ].filter(Boolean);
  return notes.length > 0 ? `${head}; ${notes.join(', ')}` : head;
}

/** `list` with the item at `from` moved to `to` (both clamped to the list). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1) as [T];
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

/** What a move says to a screen reader: "“Logo” moved to position 2 of 5". */
export const movedAnnouncement = (name: string, to: number, total: number): string =>
  `“${name}” moved to position ${to + 1} of ${total}`;

// --- share links ------------------------------------------------------------------

export type ShareExpiryChoice = '1d' | '7d' | '30d' | 'custom';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The expiry presets the share dialog offers, then a date of your own. */
export const SHARE_EXPIRY_CHOICES: readonly { value: ShareExpiryChoice; label: string }[] = [
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'custom', label: 'Custom' },
];

const PRESET_MS: Record<Exclude<ShareExpiryChoice, 'custom'>, number> = {
  '1d': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

/**
 * The instant a link expires: a preset counted from `now`, or the custom `datetime-local` value
 * on the reader's clock. Null when the custom date is empty or unreadable. Whether it is in range
 * (5 minutes to 90 days out) is the API's to say.
 */
export function shareExpiresAt(
  choice: ShareExpiryChoice,
  custom: string,
  now: number,
): string | null {
  if (choice === 'custom') return localInputToIso(custom);
  return new Date(now + PRESET_MS[choice]).toISOString();
}

// --- zip downloads ----------------------------------------------------------------

/** Whether a zip is still being built (and so worth asking about again). */
export const zipRunning = (zip: Pick<AssetZip, 'status'>): boolean =>
  zip.status === 'pending' || zip.status === 'running';

/** How far a zip has got, 0..100: parts written of the parts planned (0 until it is planned). */
export function zipPercent(zip: Pick<AssetZip, 'status' | 'partsDone' | 'partCount'>): number {
  if (zip.status === 'completed') return 100;
  if (!zip.partCount) return 0;
  return Math.min(100, Math.round((zip.partsDone / zip.partCount) * 100));
}

/** The zip's status line: "Preparing “x.zip”…", "Zipping 12 files…", "“x.zip” is ready (3 MB)". */
export function zipSummary(zip: AssetZip): string {
  const files = zip.fileCount !== undefined ? plural(zip.fileCount, 'file') : 'the files';
  switch (zip.status) {
    case 'pending':
      return `Preparing “${zip.fileName}”…`;
    case 'running':
      return `Zipping ${files} into “${zip.fileName}”…`;
    case 'completed':
      return `“${zip.fileName}” is ready: ${files}${zip.totalBytes !== undefined ? `, ${fileSize(zip.totalBytes)}` : ''}`;
    case 'failed':
      return `“${zip.fileName}” wasn’t built`;
  }
}

// --- multipart uploads -------------------------------------------------------------

/**
 * The most one signed PUT takes (the api's request cap, 100 MiB); a bigger file goes up in parts.
 * The api's own constant, mirrored: the admin doesn't import the application layer.
 */
export const SINGLE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Whether a file of `size` bytes goes up in parts. */
export const uploadsInParts = (size: number): boolean => size > SINGLE_UPLOAD_MAX_BYTES;

/** Where a multipart upload stands: bytes stored so far, parts done, and any part retrying. */
export interface PartsProgress {
  readonly loaded: number;
  readonly total: number;
  readonly partsDone: number;
  readonly partCount: number;
  /** A part waiting to try again (its last attempt failed); null when none is. */
  readonly retryingPart: number | null;
}

/** The steps of a multipart upload, as the management client takes them. */
export type MultipartClient = Pick<
  ManagementClient,
  | 'startAssetUpload'
  | 'signAssetUploadParts'
  | 'putUploadPart'
  | 'completeAssetUpload'
  | 'abortAssetUpload'
>;

/** The steps of replacing a file in parts. */
export type ReplaceInPartsClient = Omit<MultipartClient, 'startAssetUpload'> &
  Pick<ManagementClient, 'startAssetFileUpload'>;

export interface PartsUploadOptions {
  readonly folderId?: string;
  readonly onProgress?: (progress: PartsProgress) => void;
  /** Cancels the upload; the upload is aborted on the server too. */
  readonly signal?: AbortSignal;
  /** Parts in flight at once. */
  readonly concurrency?: number;
  /** Attempts per part before the upload is given up. */
  readonly attempts?: number;
  /** Waits between attempts; injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Whether a failed step is worth another attempt: a part's PUT always is (its URL is signed
 * again), as is a server error or a dropped connection; a refusal by the API (a 4xx other than a
 * timeout or a rate limit) won't change on its own.
 */
export function retryable(err: unknown): boolean {
  if (err instanceof UploadPartError) return true;
  if (err instanceof ApiError) return err.status >= 500 || err.status === 408 || err.status === 429;
  return !(err instanceof DOMException && err.name === 'AbortError');
}

const backoff = (attempt: number) => 500 * 2 ** attempt;

/**
 * Uploads a file past {@link SINGLE_UPLOAD_MAX_BYTES} as a new draft asset, in the parts the API
 * plans: each part signed and PUT `concurrency` at a time, a failed part signed again and retried
 * with backoff (500 ms, 1 s, 2 s…), then completed with every part's ETag. Progress counts bytes
 * storage has confirmed. A cancel, or a part out of attempts, aborts the upload on the server
 * (which deletes the empty draft) and rejects.
 */
export async function uploadInParts(
  client: MultipartClient,
  file: File,
  opts: PartsUploadOptions = {},
): Promise<Asset> {
  opts.signal?.throwIfAborted();
  const started = await client.startAssetUpload({
    fileName: file.name,
    contentType: file.type || 'application/octet-stream',
    size: file.size,
    title: file.name,
    ...(opts.folderId ? { folderId: opts.folderId } : {}),
  });
  return sendParts(client, file, started.asset.id, started.upload, opts);
}

/**
 * Replaces an asset's file with one past {@link SINGLE_UPLOAD_MAX_BYTES}, in parts, exactly as
 * {@link uploadInParts} sends a new one; completing commits the next version (a 409 when another
 * replace or restore committed first). A cancel, or a part out of attempts, aborts the upload,
 * and the asset keeps the file it has.
 */
export async function replaceInParts(
  client: ReplaceInPartsClient,
  assetId: string,
  file: File,
  opts: Omit<PartsUploadOptions, 'folderId'> = {},
): Promise<Asset> {
  opts.signal?.throwIfAborted();
  const started = await client.startAssetFileUpload(assetId, {
    fileName: file.name,
    contentType: file.type || 'application/octet-stream',
    size: file.size,
  });
  return sendParts(client, file, assetId, started.upload, opts);
}

async function sendParts(
  client: Omit<MultipartClient, 'startAssetUpload'>,
  file: File,
  assetId: string,
  upload: { readonly uploadId: string; readonly partSize: number; readonly partCount: number },
  opts: Omit<PartsUploadOptions, 'folderId'>,
): Promise<Asset> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 4;
  const { signal } = opts;
  const { uploadId, partSize, partCount } = upload;
  const total = file.size;
  let loaded = 0;
  let partsDone = 0;
  const retrying = new Set<number>();
  const report = () =>
    opts.onProgress?.({
      loaded,
      total,
      partsDone,
      partCount,
      retryingPart: retrying.size > 0 ? Math.min(...retrying) : null,
    });
  report();

  const sendPart = async (n: number): Promise<{ partNumber: number; etag: string }> => {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        // Signed again on each attempt: a URL lives 15 minutes, and a retry may outlast it.
        const [signed] = (await client.signAssetUploadParts(assetId, uploadId, [n])).parts;
        if (!signed) throw new UploadPartError(0, `part ${n} was not signed`);
        const from = (n - 1) * partSize;
        const etag = await client.putUploadPart(
          signed.url,
          file.slice(from, from + signed.length),
          signal,
        );
        retrying.delete(n);
        partsDone += 1;
        loaded += signed.length;
        report();
        return { partNumber: n, etag };
      } catch (err) {
        if (signal?.aborted || !retryable(err) || attempt >= attempts - 1) throw err;
        retrying.add(n);
        report();
        await sleep(backoff(attempt));
      }
    }
  };

  try {
    const parts: { partNumber: number; etag: string }[] = new Array(partCount);
    let next = 0;
    let failure: unknown;
    const lane = async () => {
      while (failure === undefined && next < partCount) {
        const i = next++;
        try {
          parts[i] = await sendPart(i + 1);
        } catch (err) {
          failure ??= err;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, partCount)) }, lane),
    );
    if (failure !== undefined) throw failure;
    signal?.throwIfAborted();
    return await client.completeAssetUpload(assetId, uploadId, parts);
  } catch (err) {
    // Nothing is left behind: the parts are discarded (and a new asset's empty draft deleted).
    await client.abortAssetUpload(assetId, uploadId).catch(() => undefined);
    throw err;
  }
}
