import { StatusBadge } from '@commerceworker/content-admin/components/status';
import { fileSize, type PartsProgress } from '@commerceworker/content-admin/lib/assets';
import { Button } from '@commerceworker/ui/button';
import { Progress } from '@commerceworker/ui/progress';
import { X } from 'lucide-react';

export type UploadState = 'queued' | 'uploading' | 'retrying' | 'done' | 'failed' | 'cancelled';

export interface UploadItem {
  readonly id: string;
  readonly name: string;
  readonly state: UploadState;
  readonly error?: string;
  /** A file going up in parts: bytes stored, parts done, any part retrying. */
  readonly progress?: PartsProgress;
  /** Whether Cancel is offered (a multipart upload under way, or any file still waiting). */
  readonly cancellable?: boolean;
}

const STATE: Record<UploadState, { status: string; label: string }> = {
  queued: { status: 'pending', label: 'Waiting' },
  uploading: { status: 'running', label: 'Uploading' },
  // Still under way, on a clock: a part waits to try again.
  retrying: { status: 'running', label: 'Retrying' },
  done: { status: 'completed', label: 'Uploaded' },
  failed: { status: 'failed', label: 'Failed' },
  cancelled: { status: 'cancelled', label: 'Cancelled' },
};

const finished = (i: UploadItem) =>
  i.state === 'done' || i.state === 'failed' || i.state === 'cancelled';

/** "Uploading 1 of 3" while it runs; then "Uploaded 2 files; 1 failed, 1 cancelled". */
export function uploadSummary(items: readonly UploadItem[]): string {
  const done = items.filter((i) => i.state === 'done').length;
  const failed = items.filter((i) => i.state === 'failed').length;
  const cancelled = items.filter((i) => i.state === 'cancelled').length;
  const ended = items.filter(finished).length;
  if (ended < items.length) return `Uploading ${ended} of ${items.length}`;
  const uploaded = `Uploaded ${done} ${done === 1 ? 'file' : 'files'}`;
  const notes = [
    failed > 0 ? `${failed} failed` : '',
    cancelled > 0 ? `${cancelled} cancelled` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return notes ? `${uploaded}; ${notes}` : uploaded;
}

/** "120 MB of 400 MB · part 3 of 50", and the part retrying when one is. */
export function partsLine(p: PartsProgress): string {
  const bytes = `${fileSize(p.loaded)} of ${fileSize(p.total)}`;
  const parts = `${p.partsDone} of ${p.partCount} parts`;
  const retry = p.retryingPart !== null ? ` · retrying part ${p.retryingPart}` : '';
  return `${bytes} · ${parts}${retry}`;
}

/**
 * The files of a drop or a pick, each with where its upload stands, and the batch's progress. A
 * large file goes up in parts: its row shows the bytes stored and the parts done in a progress bar
 * of its own, says when a part is retrying, and can be cancelled (as can a file still waiting).
 * A batch dropped on an open collection says it goes into that collection.
 * The summary is a polite live region, so a screen reader hears the batch move and finish.
 */
export function AssetUploadList(props: {
  items: readonly UploadItem[];
  onDismiss: () => void;
  onCancel?: (id: string) => void;
  /** The collection the batch goes into (uploaded at the library root, then added to it). */
  into?: string;
}) {
  const { items } = props;
  if (items.length === 0) return null;
  const ended = items.filter(finished).length;
  const running = ended < items.length;
  return (
    <section aria-label="Uploads" className="card space-y-3 p-4">
      <div className="flex items-center gap-3">
        <p className="section-title" role="status">
          {uploadSummary(items)}
        </p>
        {!running && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={props.onDismiss}
          >
            Dismiss
          </Button>
        )}
      </div>
      {props.into && (
        <p className="text-muted-foreground text-xs">
          Into the collection “{props.into}”: filed at the library root, then added to it.
        </p>
      )}
      <Progress
        value={Math.round((ended / items.length) * 100)}
        aria-label="Upload progress"
        className="h-1.5"
      />
      <ul className="divide-y text-sm">
        {items.map((item) => {
          const p = item.progress;
          const live = item.state === 'uploading' || item.state === 'retrying';
          return (
            <li key={item.id} className="space-y-1.5 py-1.5">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {item.error && (
                  <span className="min-w-0 truncate text-muted-foreground text-xs">
                    {item.error}
                  </span>
                )}
                <StatusBadge status={STATE[item.state].status} label={STATE[item.state].label} />
                {item.cancellable && !finished(item) && props.onCancel && (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Cancel uploading “${item.name}”`}
                    onClick={() => props.onCancel?.(item.id)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                )}
              </div>
              {p && live && (
                <div className="space-y-1">
                  <Progress
                    value={Math.round((p.loaded / Math.max(1, p.total)) * 100)}
                    aria-label={`Uploading “${item.name}”`}
                    getValueLabel={() => partsLine(p)}
                    className="h-1"
                  />
                  <p className="text-muted-foreground text-xs tabular-nums">{partsLine(p)}</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
