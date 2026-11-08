import { type Asset, type AssetCollection, MAX_COLLECTION_ITEMS } from '@commerceworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { cn } from '@commerceworker/ui/lib/utils';
import { Skeleton, SkeletonText } from '@commerceworker/ui/skeleton';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Download,
  GalleryVerticalEnd,
  GripVertical,
  Pencil,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import { type DragEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AssetPreview } from '~/cms/components/AssetPreview';
import { CollectionForm } from '~/cms/components/assets/AssetCollectionList';
import { AssetShareDialog } from '~/cms/components/assets/AssetShareDialog';
import { AssetZipProgress, type AssetZipState } from '~/cms/components/assets/AssetZipProgress';
import { ConfirmDialog } from '~/cms/components/ConfirmDialog';
import { LoadingStatus } from '~/cms/components/loading';
import { EmptyState } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { assetName, movedAnnouncement, moveItem } from '~/cms/lib/assets';
import { useClient } from '~/cms/lib/client-context';
import { plural } from '~/cms/lib/format';
import { apiErrorMessage } from '~/cms/lib/management';
import { useToast } from '~/cms/lib/toast';

/** A page of a collection this size: the API's most, so a whole collection is a few pages. */
const COLLECTION_PAGE_SIZE = 100;

/**
 * One collection, in place of the library: its name and description, then its assets in the order
 * an editor chose. Reorder by dragging a row, or with its Move up and Move down buttons (the
 * keyboard's way; focus stays on the moved row and the new place is announced). Each reorder sends
 * the whole order loaded so far, which the API puts first, keeping any members not yet loaded
 * after them. Remove takes an asset out of the collection only; Edit, Share, Download as zip and
 * Delete act on the collection.
 */
export function AssetCollectionView(props: {
  collection: AssetCollection;
  locale: string;
  /** Focus the heading on open (a collection just made). */
  focusOnOpen?: boolean;
  onOpenAsset: (asset: Asset) => void;
  /** The collection changed (renamed, an asset removed): the sidebar's counts go stale. */
  onChanged: () => void;
  onDeleted: () => void;
  /**
   * The library's zip of a collection: it outlives this view, so a zip started here can still be
   * downloaded after a look at the library. Shown here while it is of this collection.
   */
  zip: AssetZipState;
}) {
  const { collection, locale } = props;
  const { client, conn } = useClient();
  const toast = useToast();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  // After a move by button: the row and the button that should keep focus.
  const [focusAfter, setFocusAfter] = useState<{ id: string; dir: 'up' | 'down' } | null>(null);
  const { zip } = props;
  const zipHere =
    zip.zip?.source.kind === 'collection' && zip.zip.source.collectionId === collection.id
      ? zip.zip
      : null;
  // Reorders and removes go one after another, so the last order sent is the one that stands.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  // Under the library's `assets` key, so a publish or archive elsewhere refreshes it too. Every
  // status: the order covers archived members as well, and the count includes them.
  const pages = useInfiniteQuery({
    queryKey: [conn.space, conn.environment, 'assets', 'collection', collection.id],
    queryFn: ({ pageParam }) =>
      client.listAssetCollectionAssets(collection.id, {
        status: 'all',
        limit: COLLECTION_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor,
  });
  const fetched = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const [items, setItems] = useState<Asset[]>([]);
  // The order the server holds as far as this screen knows: what loaded, then each reorder and
  // remove it took.
  const saved = useRef<Asset[]>([]);
  useEffect(() => {
    saved.current = fetched;
    setItems(fetched);
  }, [fetched]);

  useEffect(() => {
    if (props.focusOnOpen) heading.current?.focus();
  }, [props.focusOnOpen]);

  useEffect(() => {
    if (!focusAfter) return;
    const row = list.current?.querySelector<HTMLElement>(
      `[data-asset-id="${CSS.escape(focusAfter.id)}"]`,
    );
    const wanted = row?.querySelector<HTMLButtonElement>(`[data-move="${focusAfter.dir}"]`);
    const other = row?.querySelector<HTMLButtonElement>(
      `[data-move="${focusAfter.dir === 'up' ? 'down' : 'up'}"]`,
    );
    // At the top (or bottom) the button just used is disabled: the other one keeps the row.
    (wanted && !wanted.disabled ? wanted : other)?.focus();
    setFocusAfter(null);
  }, [focusAfter, items]);

  const move = (from: number, to: number, dir?: 'up' | 'down') => {
    if (from === to || to < 0 || to >= items.length) return;
    const moved = items[from];
    if (!moved) return;
    const next = moveItem(items, from, to);
    setItems(next);
    setAnnouncement(movedAnnouncement(assetName(moved, locale), to, next.length));
    if (dir) setFocusAfter({ id: moved.id, dir });
    // The whole loaded order: one reorder takes as many ids as a collection holds.
    const order = next.map((a) => a.id).slice(0, MAX_COLLECTION_ITEMS);
    queue.current = queue.current.then(() =>
      client.reorderAssetCollection(collection.id, order).then(
        () => {
          saved.current = next;
        },
        (e) => {
          toast.error(`The new order wasn’t saved: ${apiErrorMessage(e)}`);
          // Read the order back rather than guess it: moves queued after this one may have landed.
          void resync();
        },
      ),
    );
  };

  /** Puts the screen back on the server's order (a refetch with the same data changes nothing). */
  const resync = async () => {
    const r = await pages.refetch();
    const fresh = r.data?.pages.flatMap((p) => p.items);
    if (!fresh) return;
    saved.current = fresh;
    setItems(fresh);
  };

  const remove = async (asset: Asset, index: number) => {
    const name = assetName(asset, locale);
    // In the queue with the reorders: a remove never races a move sent before it.
    const done = queue.current.then(() =>
      client.removeFromAssetCollection(collection.id, [asset.id]),
    );
    queue.current = done.catch(() => undefined);
    try {
      await done;
      saved.current = saved.current.filter((a) => a.id !== asset.id);
      setItems((list) => list.filter((a) => a.id !== asset.id));
      toast.success(`Removed “${name}” from “${collection.name}”`);
      props.onChanged();
      // Focus goes to the row that takes its place, else the heading.
      const nextRow = items[index + 1] ?? items[index - 1];
      requestAnimationFrame(() => {
        const target = nextRow
          ? list.current?.querySelector<HTMLElement>(
              `[data-asset-id="${CSS.escape(nextRow.id)}"] [data-open-asset]`,
            )
          : null;
        (target ?? heading.current)?.focus();
      });
    } catch (e) {
      toast.error(apiErrorMessage(e));
    }
  };

  const save = async (values: { name: string; description: string }) => {
    try {
      await client.updateAssetCollection(collection.id, values);
      toast.success(`Saved “${values.name}”`);
      setEditing(false);
      props.onChanged();
      heading.current?.focus();
    } catch (e) {
      toast.error(apiErrorMessage(e));
    }
  };

  const deleteCollection = async () => {
    await client.deleteAssetCollection(collection.id);
    toast.success(`Deleted collection “${collection.name}”`);
    props.onDeleted();
  };

  const onDragStart = (e: DragEvent, id: string) => {
    setDragging(id);
    // Firefox starts a drag only with data set.
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  };
  const onDrop = (e: DragEvent, to: number) => {
    e.preventDefault();
    const from = items.findIndex((a) => a.id === dragging);
    setDragging(null);
    setOver(null);
    if (from >= 0) move(from, to);
  };

  const count = Math.max(collection.itemCount, items.length);

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="caption">Collection</p>
          <h2
            id={headingId}
            ref={heading}
            tabIndex={-1}
            className="truncate font-semibold text-lg outline-none"
          >
            {collection.name}
          </h2>
          {collection.description && (
            <p className="max-w-measure text-muted-foreground text-sm">{collection.description}</p>
          )}
          <p className="text-muted-foreground text-xs">{plural(count, 'asset')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setSharing(true)}
            aria-haspopup="dialog"
          >
            <Share2 aria-hidden="true" />
            Share
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={zip.starting || count === 0}
            onClick={() => void zip.start({ collectionId: collection.id, name: collection.name })}
          >
            <Download aria-hidden="true" />
            Download as zip
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Edit “${collection.name}”`}
            aria-expanded={editing}
            onClick={() => setEditing((e) => !e)}
          >
            <Pencil aria-hidden="true" />
            Edit
          </Button>
          <ConfirmDialog
            message={`Delete “${collection.name}”?`}
            note="Its assets stay in the library; links shared to it stop opening."
            confirmLabel="Delete collection"
            onConfirm={deleteCollection}
          >
            {(ask) => (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Delete “${collection.name}”`}
                onClick={ask}
              >
                <Trash2 aria-hidden="true" />
                Delete
              </Button>
            )}
          </ConfirmDialog>
        </div>
      </div>

      {editing && (
        <div className="card max-w-md p-3">
          <CollectionForm
            label={`Edit “${collection.name}”`}
            submitLabel="Save"
            initial={{
              name: collection.name,
              ...(collection.description ? { description: collection.description } : {}),
            }}
            onCancel={() => setEditing(false)}
            onSubmit={save}
          />
        </div>
      )}

      {zipHere && (
        <AssetZipProgress
          zip={zipHere}
          onRefresh={() => void zip.refresh()}
          onDismiss={zip.dismiss}
        />
      )}

      {/* Where a move put an asset, said once it is made. */}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      {pages.isPending ? (
        <div className="card space-y-2 p-3">
          <LoadingStatus>Loading the collection…</LoadingStatus>
          {Array.from({ length: Math.min(4, Math.max(1, collection.itemCount)) }, (_, i) => (
            <div key={i} className="flex items-center gap-3" aria-hidden="true">
              <Skeleton className="size-10 rounded-lg" />
              <SkeletonText width={['64%', '48%', '72%', '55%'][i % 4]} />
            </div>
          ))}
        </div>
      ) : pages.error && items.length === 0 ? (
        <Alert variant="destructive">
          <AlertTitle>The collection didn’t load</AlertTitle>
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
      ) : items.length === 0 ? (
        <EmptyState
          icon={GalleryVerticalEnd}
          title="Nothing in this collection yet"
          description="Select assets in the library, then choose Add to collection."
        />
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            Drag a row to reorder, or use its arrows. The order is kept for sharing and zips.
          </p>
          <ol
            ref={list}
            aria-label={`Assets in “${collection.name}”, in order`}
            className="card divide-y overflow-clip"
          >
            {items.map((a, i) => {
              const name = assetName(a, locale);
              return (
                <li
                  key={a.id}
                  data-asset-id={a.id}
                  draggable
                  onDragStart={(e) => onDragStart(e, a.id)}
                  onDragOver={(e) => {
                    if (!dragging) return;
                    e.preventDefault();
                    setOver(i);
                  }}
                  onDragLeave={() => setOver((o) => (o === i ? null : o))}
                  onDrop={(e) => onDrop(e, i)}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  className={cn(
                    // On a phone the actions take a line of their own under the name.
                    'flex items-center gap-2 px-3 py-2 transition-[background-color] max-md:flex-wrap',
                    dragging === a.id && 'opacity-60',
                    over === i && dragging !== a.id && 'bg-muted',
                  )}
                >
                  <GripVertical
                    aria-hidden="true"
                    className="size-4 shrink-0 cursor-grab text-muted-foreground"
                  />
                  <span
                    aria-hidden="true"
                    className="w-6 shrink-0 text-right text-muted-foreground text-xs tabular-nums"
                  >
                    {i + 1}
                  </span>
                  <AssetPreview asset={a} alt="" className="size-10 shrink-0 rounded-lg" />
                  <button
                    type="button"
                    data-open-asset=""
                    onClick={() => props.onOpenAsset(a)}
                    aria-label={`Open “${name}”`}
                    className="hit-area min-w-0 flex-1 truncate rounded-full text-left font-medium text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {name}
                  </button>
                  <StatusBadge status={a.status} />
                  {/* A finger's 44px targets (hit-area) must not overlap: icon-xs is 24px, so 20px
                      apart on a coarse pointer. */}
                  <div className="flex shrink-0 items-center gap-0.5 max-md:ml-auto max-md:w-full max-md:justify-end pointer-coarse:gap-5">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      data-move="up"
                      aria-label={`Move “${name}” up`}
                      disabled={i === 0}
                      onClick={() => move(i, i - 1, 'up')}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      data-move="down"
                      aria-label={`Move “${name}” down`}
                      disabled={i === items.length - 1}
                      onClick={() => move(i, i + 1, 'down')}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove “${name}” from “${collection.name}”`}
                      onClick={() => void remove(a, i)}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {pages.hasNextPage && (
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
        </div>
      )}

      <AssetShareDialog
        open={sharing}
        onOpenChange={setSharing}
        target={{ type: 'collection', id: collection.id, name: collection.name }}
      />
    </section>
  );
}
