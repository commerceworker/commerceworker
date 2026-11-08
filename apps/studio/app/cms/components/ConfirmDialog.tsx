import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@commerceworker/ui/alert-dialog';
import { Button } from '@commerceworker/ui/button';
import { DialogError } from '@commerceworker/ui/dialog';
import { type ReactNode, useRef, useState } from 'react';
import { RequestTimeoutError, refusedSave, saveFailureMessage } from '~/cms/lib/management';

/**
 * How long the dialog holds for an answer. A write times out sooner, in `req`, but what follows it
 * (reading the list again) has no limit of its own, and must not hold a person here for good.
 */
const HOLD_MS = 45_000;

export interface ConfirmDialogProps {
  /** The question, naming the thing acted on: `Delete “Spring campaign”?` */
  readonly message: ReactNode;
  /** What goes with it, and that it can't be brought back. */
  readonly note: ReactNode;
  /** Label of the safe choice, which has focus. Defaults to "Cancel". */
  readonly cancelLabel?: string;
  /** Names the act: "Delete role", not "OK". */
  readonly confirmLabel: string;
  /** Disables the confirming button (e.g. while another request is in flight). */
  readonly busy?: boolean;
  /**
   * Runs the act. The dialog stays, the act held, until this settles, so a second press can't send
   * it twice and focus moves on from what is left once the list has been read again. A rejection
   * is said in the dialog, which stays open; one with no answer says it may have gone through, and
   * the safe choice stops claiming to keep anything.
   */
  readonly onConfirm: () => void | Promise<unknown>;
  /** Where focus goes as it closes, for an answer that takes it elsewhere. */
  readonly onCloseAutoFocus?: (event: Event) => void;
  /** Renders the trigger; call `ask` from its onClick to open the dialog. */
  readonly children: (ask: () => void) => ReactNode;
}

/**
 * A trigger that asks in a modal before removing something for good: how anything irreversible
 * that touches content, files or access confirms (`ConfirmButton` is its in-place counterpart, for
 * what can be undone). The safe choice has focus, and closing goes back to the trigger, or to what
 * stood beside it when the act took it away.
 *
 * ```tsx
 * <ConfirmDialog
 *   message={`Delete the role “${role.name}”?`}
 *   note="This can’t be undone."
 *   confirmLabel="Delete role"
 *   onConfirm={() => remove(role.id)}
 * >
 *   {(ask) => <Button variant="ghost" size="sm" onClick={ask}>Delete</Button>}
 * </ConfirmDialog>
 * ```
 */
export function ConfirmDialog({
  message,
  note,
  cancelLabel = 'Cancel',
  confirmLabel,
  busy,
  onConfirm,
  onCloseAutoFocus,
  children,
}: ConfirmDialogProps) {
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string>();
  // A try that got no answer may have landed, so nothing here may say it didn't.
  const [mayHaveLanded, setMayHaveLanded] = useState(false);
  // The state lags a double press: this doesn't.
  const sent = useRef(false);
  const held = sending || busy;

  const confirm = async () => {
    if (sent.current || busy) return;
    sent.current = true;
    setSending(true);
    setFailed(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        onConfirm(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new RequestTimeoutError(true)), HOLD_MS);
        }),
      ]);
      setAsking(false);
    } catch (err) {
      const said = saveFailureMessage(err);
      // A refused retry doesn't speak for a try before it that may have landed.
      setFailed(mayHaveLanded && refusedSave(err) ? `This try was refused. ${said}` : said);
      if (!refusedSave(err)) setMayHaveLanded(true);
    } finally {
      clearTimeout(timer);
      sent.current = false;
      setSending(false);
    }
  };

  return (
    <>
      {children(() => setAsking(true))}
      <AlertDialog
        open={asking}
        onOpenChange={(open) => {
          // It has been sent: leaving wouldn't call it back, so the dialog waits for the answer.
          if (sent.current) return;
          setFailed(undefined);
          setMayHaveLanded(false);
          setAsking(open);
        }}
      >
        <AlertDialogContent {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}>
          <AlertDialogHeader>
            <AlertDialogTitle>{message}</AlertDialogTitle>
            <AlertDialogDescription>{note}</AlertDialogDescription>
          </AlertDialogHeader>
          {sending ? (
            <p role="status" className="text-muted-foreground text-sm">
              Waiting for the answer. This closes when it’s done.
            </p>
          ) : null}
          {failed ? <DialogError>{failed}</DialogError> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>
              {mayHaveLanded ? 'Close' : cancelLabel}
            </AlertDialogCancel>
            {/* Not `disabled`: focus stays on it through the wait, for a refusal to find it there. */}
            <Button
              type="button"
              variant="destructive"
              aria-disabled={held || undefined}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={() => void confirm()}
            >
              {confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
