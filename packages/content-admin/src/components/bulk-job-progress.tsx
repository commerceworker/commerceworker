import { ConfirmButton } from '@commerceworker/content-admin/components/InlineConfirm';
import { StatusBadge, ToneBadge } from '@commerceworker/content-admin/components/status';
import { bulkSummary, jobOutcome } from '@commerceworker/content-admin/lib/bulk-jobs';
import { plural } from '@commerceworker/content-admin/lib/format';
import type { BulkJobSummary } from '@commerceworker/content-admin/lib/management';
import { Button } from '@commerceworker/ui/button';
import { Progress } from '@commerceworker/ui/progress';
import { useEffect, useRef } from 'react';

/**
 * A bulk action running as a job on the server, whatever it acts on: batches, not items, because
 * batches are what complete (a count that moved a chunk at a time would look stuck between
 * jumps), in the upload queue's Progress bar, with the reassurance that it keeps going if the tab
 * closes. A job that ended with failures is stamped as waiting on a person, never as done. The
 * summary line is a polite live region, so its end is heard. What failed is named beside it, by
 * the screen's failures Alert, once the report is read.
 *
 * A running job can be stopped (confirmed in place). A stop is a stop to new batches, not a
 * rollback: batches done stay done, and one under way when it came may still finish, so the card
 * says how far it had got and that the screen shows what changed (it reloads as the job ends).
 * When the job ends, focus that was on its Stop (now gone) moves to Dismiss.
 */
export function BulkJobProgress(props: {
  job: BulkJobSummary;
  /** The action's words, done ("Published") and under way ("Publishing"). */
  verbs: { readonly done: string; readonly doing: string };
  /** What it acts on, singular and plural: `['entry', 'entries']`. */
  nouns: readonly [string, string];
  /** Where a person sees what changed: "the library", "the list". */
  where: string;
  onDismiss: () => void;
  /** Stops the job; absent, the card offers no Stop. */
  onCancel?: () => void;
  /** A stop is on its way to the server. */
  cancelling?: boolean;
  /**
   * Take focus when the card arrives, if nothing else holds it: the action that started the job
   * now waits (disabled), and focus must not fall to the page. Focus elsewhere (the assistant's
   * panel, a field) stays where it is.
   */
  takeFocus?: boolean;
}) {
  const { job, verbs, nouns } = props;
  const running = job.status === 'running';
  const cancelled = job.status === 'cancelled';
  const dismiss = useRef<HTMLButtonElement>(null);
  const stop = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  // Once, as it arrives: on Stop while it runs, else (it finished at once) on Dismiss.
  useEffect(() => {
    if (!props.takeFocus) return;
    const at = document.activeElement;
    const idle = !at || at === document.body || (at instanceof HTMLButtonElement && at.disabled);
    if (idle) (stop.current ?? dismiss.current)?.focus();
  }, []);
  useEffect(() => {
    if (running) return;
    // Its Stop (or the confirm in its place) went with the job: don't drop focus on the page.
    const at = document.activeElement;
    if (!at || at === document.body || card.current?.contains(at)) dismiss.current?.focus();
  }, [running]);
  const summary = running
    ? `${verbs.doing} ${plural(job.totalItems, nouns[0], nouns[1])}…`
    : cancelled
      ? `Stopped: ${bulkSummary(verbs.done, jobOutcome(job), nouns)}`
      : bulkSummary(verbs.done, jobOutcome(job), nouns);
  return (
    <section ref={card} aria-label="Bulk job" className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="section-title" role="status">
          {summary}
        </p>
        {!running && job.status !== 'cancelled' && job.failed > 0 ? (
          <ToneBadge tone="wait" label="Finished with failures" />
        ) : (
          <StatusBadge status={job.status} />
        )}
        {running && props.onCancel && (
          <ConfirmButton
            message="Stop this bulk job?"
            note={`Batches already done stay ${verbs.done.toLowerCase()}, and one under way may still finish; the rest are left as they are.`}
            cancelLabel="Keep running"
            confirmLabel="Stop job"
            busy={props.cancelling}
            onConfirm={props.onCancel}
          >
            {(ask) => (
              <Button
                ref={stop}
                type="button"
                size="xs"
                variant="ghost"
                className="ml-auto"
                disabled={props.cancelling}
                onClick={ask}
              >
                {props.cancelling ? 'Stopping…' : 'Stop'}
              </Button>
            )}
          </ConfirmButton>
        )}
        {!running && (
          <Button
            ref={dismiss}
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
      <Progress
        value={Math.round((job.completedChunks / Math.max(1, job.totalChunks)) * 100)}
        aria-label="Bulk job progress"
        className="h-1.5"
      />
      <p className="text-muted-foreground text-xs">
        {running
          ? `${job.completedChunks} of ${plural(job.totalChunks, 'batch', 'batches')} done; this keeps running if you close the tab.`
          : cancelled
            ? `Stopped after ${job.completedChunks} of ${plural(job.totalChunks, 'batch', 'batches')}. A batch under way when you stopped may still finish; ${props.where} shows what changed.`
            : `${plural(job.totalChunks, 'batch', 'batches')} done.`}
      </p>
    </section>
  );
}
