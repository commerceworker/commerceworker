import { StatusBadge } from '@commerceworker/content-admin/components/status';
import type { ContentType, ReleaseItem } from '@commerceworker/domain';
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
import { Badge } from '@commerceworker/ui/badge';
import { useQueries } from '@tanstack/react-query';
import { Rocket } from 'lucide-react';
import { useClient } from '../lib/client-context';
import type { PreviewEntry } from '../lib/management';
import { useContentTypesQuery, useQueryKeys, useScopedQuery } from '../lib/queries';

/** Members listed by title in the confirm; the rest collapse into "+N more". */
const LIST_CAP = 5;
/** Members whose status is looked up (one request each) to flag drafts and missing entries. */
const CHECK_CAP = 25;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface Member {
  readonly item: ReleaseItem;
  /** `undefined` while loading or past the check cap; `null` when the lookup failed. */
  readonly entry: PreviewEntry | null | undefined;
}

function titleOf(entry: PreviewEntry, types: readonly ContentType[], locale: string): string {
  const df = types.find((t) => t.apiId === entry.contentType)?.displayField;
  const value = df
    ? (entry.fields[df] as Record<string, unknown> | undefined)?.[locale]
    : undefined;
  return typeof value === 'string' && value ? value : entry.id;
}

/**
 * "Publish this release?" before it ships, in a modal since it can't be undone: what goes out (count, titles, capped
 * with "+N more") and what to look at first (entries going live for the first
 * time, entries that will be unpublished, members in the trash or gone, which
 * make the whole transaction fail). Shares the `['release', id]` cache with the
 * detail sheet, so opening it from either place costs at most one fetch.
 */
export function ReleasePublishConfirm(props: {
  readonly releaseId: string;
  readonly releaseTitle: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly returnFocus?: () => HTMLElement | null | undefined;
}) {
  const { client, conn } = useClient();
  const keys = useQueryKeys();
  const types = useContentTypesQuery().data ?? [];
  const detail = useScopedQuery(['release', props.releaseId], () =>
    client.getRelease(props.releaseId),
  );
  const items = detail.data?.items ?? [];
  const checked = items.slice(0, CHECK_CAP);
  const lookups = useQueries({
    queries: checked.map((it) => ({
      queryKey: keys.entry(it.entityId),
      queryFn: () => client.getEntry(it.entityId),
      retry: false,
      meta: { silent: true },
    })),
  });

  const members: Member[] = items.map((item, i) => {
    const q = i < CHECK_CAP ? lookups[i] : undefined;
    return { item, entry: q?.isError ? null : q?.data };
  });
  const toPublish = items.filter((it) => it.action === 'publish').length;
  const toUnpublish = items.length - toPublish;
  const firstPublish = members.filter(
    (m) => m.item.action === 'publish' && m.entry?.status === 'draft',
  ).length;
  const missing = members.filter((m) => m.entry === null || m.entry?.status === 'archived').length;
  const checking = detail.isPending || lookups.some((q) => q.isPending);

  const name = `“${props.releaseTitle}”`;
  const note = detail.isError
    ? 'Couldn’t load its entries; publishing still ships everything in it.'
    : detail.isPending
      ? 'Checking its entries…'
      : items.length === 0
        ? 'It has no entries yet, so there is nothing to ship.'
        : toUnpublish === 0
          ? `${plural(items.length, 'entry goes', 'entries go')} live together.`
          : `${plural(toPublish, 'entry goes', 'entries go')} live and ${toUnpublish} ${
              toUnpublish === 1 ? 'is' : 'are'
            } unpublished, together.`;

  const flags: string[] = [];
  if (firstPublish > 0)
    flags.push(`${plural(firstPublish, 'entry has', 'entries have')} never been published.`);
  if (missing > 0)
    flags.push(
      `${plural(missing, 'entry is', 'entries are')} in the trash or missing, so publishing will fail until ${missing === 1 ? 'it is' : 'they are'} restored or removed.`,
    );
  if (items.length > CHECK_CAP && !checking)
    flags.push(`Statuses checked for the first ${CHECK_CAP} of ${items.length}.`);

  const shown = members.slice(0, LIST_CAP);
  const more = members.length - shown.length;

  return (
    <AlertDialog open onOpenChange={(open) => !open && props.onCancel()}>
      <AlertDialogContent
        onCloseAutoFocus={(e) => {
          const target = props.returnFocus?.();
          if (!target?.isConnected) return;
          e.preventDefault();
          target.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Publish {name}?</AlertDialogTitle>
          <AlertDialogDescription>{note}</AlertDialogDescription>
        </AlertDialogHeader>
        {items.length > 0 ? (
          <div className="space-y-2 text-sm">
            <ul className="space-y-1" aria-label="Entries in this release">
              {shown.map(({ item, entry }) => (
                <li key={item.entityId} className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {entry ? (
                      titleOf(entry, types, conn.locale)
                    ) : (
                      <code className="text-xs">{item.entityId.slice(0, 12)}</code>
                    )}
                  </span>
                  {item.action === 'unpublish' && <Badge variant="outline">unpublish</Badge>}
                  {entry === null ? (
                    <Badge variant="destructive">missing</Badge>
                  ) : entry ? (
                    <StatusBadge status={entry.status} />
                  ) : null}
                </li>
              ))}
            </ul>
            {more > 0 && <p className="text-muted-foreground text-xs">+{more} more</p>}
            {flags.length > 0 && (
              <ul className="space-y-0.5 text-wait text-xs">
                {flags.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="default"
            disabled={props.busy || detail.isPending || items.length === 0}
            onClick={props.onConfirm}
          >
            <Rocket className="size-4" />
            {items.length > 0 ? `Publish ${plural(items.length, 'entry', 'entries')}` : 'Publish'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
