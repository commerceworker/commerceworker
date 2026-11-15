import type { FieldDiff } from '@commerceworker/domain';
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
import { cn } from '@commerceworker/ui/lib/utils';
import { useId, useRef } from 'react';
import type { ManagementClient, PreviewEntry } from '../../lib/management';
import {
  ChangedFields,
  changedCount,
  EntryDiffView,
  FIRST_PUBLISH,
  fieldsGoLive,
  HiddenChanges,
  NO_CHANGES,
  ReviewHold,
  reviewFields,
  useEntryReview,
  useHandFocus,
} from './EntryReview';

/** What publishing does, for when the list below it can't say more. */
const REPLACES_LIVE = 'The draft replaces what’s live now.';

export interface PublishConfirmProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  /** What the entry is called (its display field, or "Untitled entry"). */
  readonly title: string;
  /** The entry's status before publishing: `draft` has nothing live to compare with. */
  readonly status: string | undefined;
  /**
   * Published → current, from the version diff, when the caller knows both versions (the editor,
   * right after a save). Without it, an entry that has been live is compared through `compare`.
   */
  readonly changes?: readonly FieldDiff[] | null;
  /** With `changes`: how many more changed that this person may not read. */
  readonly hiddenChanges?: number;
  /** The draft to compare with what delivery serves, when `changes` isn't known. */
  readonly compare?: {
    readonly client: ManagementClient;
    readonly entry: PreviewEntry;
    readonly locale: string;
  };
  readonly busy: boolean;
  onConfirm(): void;
  /**
   * Where focus goes once the dialog closes, when the control that asked may be gone (a row's
   * Publish disappears once the row is live). Defaults to what was focused when it opened.
   */
  readonly returnFocus?: () => HTMLElement | null | undefined;
}

/**
 * The one publish confirmation, for the editor's Publish and an entries row's alike: it names the
 * entry and says what goes live. A first publish puts the whole entry live; an entry that has been
 * live shows each field that changes, published beside draft, from the same review the assistant's
 * card reads (`EntryReview`), so publishing reads the same wherever it starts.
 */
export function PublishConfirm(props: PublishConfirmProps) {
  const { changes, compare, status, hiddenChanges = 0 } = props;
  const firstPublish = status === 'draft';
  // As the review counts them, so a field added empty doesn't read as a change it can't list.
  const listed = changes ? changedCount(reviewFields(changes, '')) : 0;
  const review = !firstPublish && (!changes || listed > 0);
  // The editor's own diff with nothing to name: there is nothing to read, but never nothing to say.
  const hiddenOnly = Boolean(changes) && listed === 0 && hiddenChanges > 0;
  // Read here, not in the diff: what it shows decides whether Publish entry may be pressed. The
  // editor's own diff has nothing left to fail, and with nothing to read, nothing can be shown.
  const read = useEntryReview(
    compare?.client,
    props.open && review && compare
      ? {
          entryId: compare.entry.id,
          ...(changes ? { changes, hiddenChanges } : {}),
        }
      : null,
    compare?.locale ?? '',
  );
  const pending = read.status === 'loading';
  const blocked = read.status === 'failed' || (review && !compare && !changes);
  // Only a finished read can say the draft matches; one that failed knows nothing.
  const matches =
    read.status === 'ready' && changedCount(read.fields) === 0 && !(read.hiddenChanges > 0);
  const reasonId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const publish = useRef<HTMLButtonElement>(null);
  useHandFocus(pending || blocked, publish, cancel, () => props.open);
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent
        // A review to read before answering, not a question: in thumb reach on a phone.
        placement="sheet"
        className={cn(review && compare && 'sm:max-w-xl')}
        onCloseAutoFocus={(e) => {
          const target = props.returnFocus?.();
          if (!target?.isConnected) return;
          e.preventDefault();
          target.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Publish “{props.title}”?</AlertDialogTitle>
          {/* A div, so the warning is part of what the dialog is described by. */}
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                {changes
                  ? listed > 0
                    ? fieldsGoLive(listed)
                    : hiddenOnly
                      ? REPLACES_LIVE
                      : NO_CHANGES
                  : firstPublish || read.status === 'first'
                    ? FIRST_PUBLISH
                    : matches
                      ? NO_CHANGES
                      : compare
                        ? REPLACES_LIVE
                        : 'Everything changed since the last publish goes live.'}
              </p>
              {hiddenOnly ? <HiddenChanges count={hiddenChanges} alone /> : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {review && (compare || changes) ? (
          <section
            aria-label="What changes"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard.
            tabIndex={0}
            className="cw-scroll cw-scroll-cue -m-1 max-h-[50dvh] min-w-0 overflow-y-auto rounded-sm p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {compare ? (
              <EntryDiffView
                review={read}
                counted={!changes && !matches}
                onRetry={() => {
                  // The button goes with the failure; focus doesn't go with it.
                  cancel.current?.focus({ preventScroll: true });
                  if (read.status === 'failed') read.retry?.();
                }}
              />
            ) : changes ? (
              <div className="space-y-3">
                <ChangedFields fields={reviewFields(changes, '')} />
                {hiddenChanges > 0 ? <HiddenChanges count={hiddenChanges} alone={false} /> : null}
              </div>
            ) : null}
          </section>
        ) : null}
        <ReviewHold id={reasonId} verb="publish" pending={pending} blocked={blocked} />
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancel}>
            {firstPublish || read.status === 'first' ? 'Keep as draft' : 'Keep live version'}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="default"
            ref={publish}
            disabled={props.busy || pending || blocked}
            aria-describedby={pending || blocked ? reasonId : undefined}
            onClick={props.onConfirm}
          >
            Publish entry
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
