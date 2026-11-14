import { BulkBar } from '@commerceworker/ui/bulk-bar';
import { Button } from '@commerceworker/ui/button';
import { ArchiveRestore, CircleSlash, Send, Trash2 } from 'lucide-react';
import { useId } from 'react';

/** The entry actions that run as bulk jobs. */
type EntryJob = 'trash' | 'restore' | 'purge';

/**
 * What can be done to the ticked entries at once, in place of the filter bar while anything is
 * ticked, and held under the shell's header as the list scrolls. It offers only what applies:
 * Publish while a ticked entry isn't live as it is (a draft or changed), Unpublish while one is
 * live, Move to trash for any. In the trash it offers Restore and Delete permanently instead.
 * Labelled as the asset library's bar is ("2 selected", "Publish selected").
 *
 * Trash, restore and delete run as background jobs, which only a role holding their actions on
 * every content type may start (the api's `canRunEntryBulkJob`); each one this role can't start is
 * disabled, and `jobsRefusal` says why.
 */
export function EntryBulkBar(props: {
  count: number;
  /** How many ticked entries each action would change. */
  publishable?: number;
  unpublishable?: number;
  busy: boolean;
  onPublish?: () => void;
  onUnpublish?: () => void;
  /** The list's bar: move the ticked entries to the trash. */
  onTrash?: () => void;
  /** The trash's bar: bring them back as drafts, or delete them for good. */
  onRestore?: () => void;
  onPurge?: () => void;
  /** The jobs this role may not start here (disabled, with `jobsRefusal` saying why). */
  deniedJobs?: readonly EntryJob[];
  /** Why the jobs in `deniedJobs` can't be started here. */
  jobsRefusal?: string;
  /** While the session's access is still being read: the job actions wait, with no reason yet. */
  jobsPending?: boolean;
  onClear: () => void;
}) {
  const reasonId = useId();
  const denied = (job: EntryJob) => props.deniedJobs?.includes(job) ?? false;
  const jobProps = (job: EntryJob) => ({
    disabled: props.busy || props.jobsPending || denied(job),
    ...(denied(job) ? { 'aria-describedby': reasonId } : {}),
  });
  const offered: EntryJob[] = [
    ...(props.onTrash ? (['trash'] as const) : []),
    ...(props.onRestore ? (['restore'] as const) : []),
    ...(props.onPurge ? (['purge'] as const) : []),
  ];
  const refused = offered.some(denied);
  return (
    <BulkBar
      label="Selected entries"
      count={props.count}
      onClear={props.onClear}
      note={
        props.jobsRefusal && refused ? (
          <p id={reasonId} className="basis-full text-muted-foreground text-xs">
            {props.jobsRefusal}
          </p>
        ) : null
      }
    >
      {props.onPublish && (props.publishable ?? 0) > 0 ? (
        <Button type="button" size="sm" disabled={props.busy} onClick={props.onPublish}>
          <Send aria-hidden="true" />
          Publish selected
        </Button>
      ) : null}
      {props.onUnpublish && (props.unpublishable ?? 0) > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-bulk-action="unpublish"
          disabled={props.busy}
          onClick={props.onUnpublish}
        >
          <CircleSlash aria-hidden="true" />
          Unpublish selected
        </Button>
      ) : null}
      {props.onTrash ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-bulk-action="trash"
          onClick={props.onTrash}
          {...jobProps('trash')}
        >
          <Trash2 aria-hidden="true" />
          Move to trash
        </Button>
      ) : null}
      {props.onRestore ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={props.onRestore}
          {...jobProps('restore')}
        >
          <ArchiveRestore aria-hidden="true" />
          Restore selected
        </Button>
      ) : null}
      {props.onPurge ? (
        <Button
          type="button"
          size="sm"
          // Outline like its neighbours: the red belongs to the confirm that follows, not the ask.
          variant="outline"
          onClick={props.onPurge}
          {...jobProps('purge')}
        >
          <Trash2 aria-hidden="true" />
          Delete permanently…
        </Button>
      ) : null}
    </BulkBar>
  );
}
