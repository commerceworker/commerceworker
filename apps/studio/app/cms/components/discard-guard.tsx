import { Button } from '@commerceworker/ui/button';
import { cn } from '@commerceworker/ui/lib/utils';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { refusedSave, saveFailureMessage } from '~/cms/lib/management';

/** The question's note once a save may have landed: "Nothing has been saved" can't be known. */
export const UNCONFIRMED_NOTE = 'A save here may have gone through; discarding won’t undo it.';

export interface DiscardGuard {
  /** Hand this to the Dialog or Sheet, and call it for Cancel: every way out goes through it. */
  readonly onOpenChange: (open: boolean) => void;
  readonly asking: boolean;
  /** A save is under way, so there is nothing to discard and no way to leave yet. */
  readonly saving: boolean;
  /** Someone tried to leave during that save, and is told why nothing happened. */
  readonly waiting: boolean;
  /** A save failed with no refusal, so it may have landed. A later refusal doesn't speak for it. */
  readonly unconfirmed: boolean;
  /** Every failed save comes here, to tell a refusal from an unknown. Returns it in words. */
  readonly saveFailed: (err: unknown) => string;
  readonly keep: () => void;
  readonly discard: () => void;
}

/**
 * Keeps a dirty form from going with a stray press outside it, Escape, the close button or Cancel.
 * All of them reach `onOpenChange(false)`, so that is the one place that asks; {@link DiscardAsk}
 * asks in place of the form's buttons. A successful save closes through the caller's own
 * `onOpenChange`, which doesn't ask.
 *
 * During a save there is no question to ask: it has been sent, and "Nothing has been saved" would
 * be untrue. The form holds, {@link GuardCancel} is disabled, and a try at leaving says so. Only a
 * save holds it: a read (a dry run, a fetch to inspect) stays closable, so leave it out of `saving`.
 *
 * After a save fails the form lets go, and what the question may say depends on how it failed: a
 * refusal saved nothing, anything else may have landed. The form hands the error to `saveFailed`,
 * and from then until it closes {@link DiscardAsk} says so in place of any note.
 */
export function useDiscardGuard({
  open = true,
  dirty,
  saving = false,
  subject,
  onOpenChange,
}: {
  open?: boolean;
  dirty: boolean;
  /** This form's own write in flight. */
  saving?: boolean;
  /** What the form edits, where that can change while it stays open. */
  subject?: unknown;
  onOpenChange: (open: boolean) => void;
}): DiscardGuard {
  const [asking, setAsking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  // Closing, or moving on to something else, starts a new form.
  useEffect(() => {
    setUnconfirmed(false);
  }, [open, subject]);
  useEffect(() => {
    if (!saving) setWaiting(false);
  }, [saving]);
  // A save that lands while the question is up answers it.
  useEffect(() => {
    if (!open || !dirty) setAsking(false);
  }, [open, dirty]);
  return {
    onOpenChange: (next) => {
      if (!next && saving) setWaiting(true);
      else if (!next && dirty) setAsking(true);
      else onOpenChange(next);
    },
    asking,
    saving,
    waiting: waiting && saving,
    unconfirmed,
    saveFailed: (err) => {
      if (!refusedSave(err)) setUnconfirmed(true);
      return saveFailureMessage(err);
    },
    keep: () => setAsking(false),
    discard: () => {
      setAsking(false);
      onOpenChange(false);
    },
  };
}

/** What a person was editing, in the dialog or sheet around `slot`. */
function useLastField(slot: RefObject<HTMLElement | null>) {
  const last = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const holder = slot.current?.closest('[role="dialog"]');
    const note = (event: Event) => {
      if (event.target instanceof HTMLElement && event.target.matches(FIELD)) {
        last.current = event.target;
      }
    };
    holder?.addEventListener('focusin', note);
    return () => holder?.removeEventListener('focusin', note);
  }, [slot]);
  return last;
}

const FIELD =
  'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="radio"], [role="checkbox"], [role="switch"]';

/** The form's buttons, or while {@link useDiscardGuard} asks, the question in their place. */
export function DiscardAsk({
  guard,
  message,
  note = 'Nothing has been saved.',
  children,
}: {
  guard: DiscardGuard;
  /** The question, naming what goes: "Discard this content type?" */
  message: ReactNode;
  /** What is at stake, when part of the form has been saved. A save that may have landed wins. */
  note?: ReactNode;
  children: ReactNode;
}) {
  const slot = useRef<HTMLSpanElement>(null);
  const field = useLastField(slot);
  return (
    <span ref={slot} className={cn(guard.asking ? 'block w-full min-w-0' : 'contents')}>
      {guard.asking ? (
        <InlineConfirm
          message={message}
          note={guard.unconfirmed ? UNCONFIRMED_NOTE : note}
          cancelLabel="Keep editing"
          onCancel={() => {
            // Keep editing means the field, wherever the asking came from.
            if (field.current?.isConnected) field.current.focus();
            guard.keep();
          }}
          // The buttons it stood in for are new ones by then.
          returnFocus={() => slot.current?.querySelector('button')}
        >
          <Button type="button" size="sm" variant="destructive" onClick={guard.discard}>
            Discard
          </Button>
        </InlineConfirm>
      ) : (
        <>
          {guard.waiting ? (
            <span role="status" className="mr-auto self-center text-muted-foreground text-ui">
              Still saving. This closes when it’s done.
            </span>
          ) : null}
          {children}
        </>
      )}
    </span>
  );
}

/** The form's Cancel: it goes through the guard, and waits while a save is under way. */
export function GuardCancel({ guard }: { guard: DiscardGuard }) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={guard.saving}
      onClick={() => guard.onOpenChange(false)}
    >
      Cancel
    </Button>
  );
}
