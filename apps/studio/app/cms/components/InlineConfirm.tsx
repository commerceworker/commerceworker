import { Button } from '@commerceworker/ui/button';
import { focusIsAdrift } from '@commerceworker/ui/lib/focus-return';
import { cn } from '@commerceworker/ui/lib/utils';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

/** Open confirmations' roots, newest last. */
const open: { readonly root: { current: HTMLElement | null } }[] = [];

/** The newest open confirm that holds `node` (focus or an event target), if any. */
function confirmHolding(node: unknown) {
  if (!(node instanceof Node)) return undefined;
  return open.findLast((c) => c.root.current?.contains(node));
}

/**
 * True while focus is inside an open inline confirm (e.g. to keep a hotkey from
 * firing under it). A confirm left open elsewhere — an AI proposal waiting in
 * the rail — doesn't hold the keyboard hostage.
 */
export function hasOpenInlineConfirm(): boolean {
  return confirmHolding(document.activeElement) !== undefined;
}

export interface InlineConfirmProps {
  /** The question, naming the thing acted on: `Delete “Spring campaign”?` */
  readonly message: ReactNode;
  /** One line of consequence, e.g. "This can’t be undone." Read out with the message. */
  readonly note?: ReactNode;
  /** Optional detail below the question (a capped list of what is affected, warnings). */
  readonly details?: ReactNode;
  /** Label of the safe choice, which receives focus. Defaults to "Cancel". */
  readonly cancelLabel?: string;
  /** Called by the safe choice and by Escape. */
  readonly onCancel: () => void;
  /**
   * Called by Escape in place of `onCancel`, where the safe choice throws work away (a model's
   * proposal, say): Escape is not a decision to discard.
   */
  readonly onEscape?: () => void;
  /**
   * Where focus goes when the confirm closes and focus would otherwise fall to
   * `<body>`. Defaults to whatever was focused when it opened, if still in the
   * DOM. Pass this when the confirm *replaces* its trigger, since the original
   * element is then gone.
   */
  readonly returnFocus?: () => HTMLElement | null | undefined;
  readonly className?: string;
  /**
   * The confirming action(s), usually one `<Button>` that names the act
   * ("Delete workflow", "Publish 12 entries"). They are children so the
   * confirm can sit inside the caller's form and the caller owns the handler.
   */
  readonly children: ReactNode;
}

/**
 * An "are you sure?" in place, where the action was: how anything undoable confirms, and the small
 * config rows DESIGN.md names. What can't be undone and reaches content, files or access takes
 * `ConfirmDialog`.
 *
 * - Focus lands on the safe choice (Cancel), so a stray Enter backs out.
 * - Escape cancels the newest open confirm only, and is swallowed so an
 *   enclosing Sheet/Dialog doesn't also close.
 * - On close, focus returns to what asked if the answer didn't move it.
 * - Announced as an `alertdialog` labelled by the message.
 *
 * Use it directly when the caller owns the open state (e.g. swapping a card
 * footer), or use {@link ConfirmButton} for a trigger that turns into its own
 * confirm.
 */
export function InlineConfirm({
  message,
  note,
  details,
  cancelLabel = 'Cancel',
  onCancel,
  onEscape,
  returnFocus,
  className,
  children,
}: InlineConfirmProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // Latest callbacks without re-running the effect, which would pull focus
  // back to the safe choice on every re-render.
  const onEscapeRef = useRef(onEscape ?? onCancel);
  onEscapeRef.current = onEscape ?? onCancel;
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;

  // In a layout effect, so the safe choice has focus in the commit that shows it. Handing focus
  // back stays in the effect below: a layout cleanup runs with this confirm still in the DOM, so
  // it couldn't tell that focus had gone.
  const asked = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // <body>, or the dialog around it, isn't "what asked" (Safari doesn't focus
    // a pressed button), so it falls through to `returnFocus`.
    const active = document.activeElement;
    asked.current = active instanceof HTMLElement && !focusIsAdrift(active) ? active : null;
    cancel.current?.focus();
  }, []);

  useEffect(() => {
    const me = { root };
    open.push(me);
    // Window capture runs before Radix's document-level Escape handling, so a
    // confirm inside a Sheet backs out of the confirm without closing the Sheet.
    // Only when the key comes from inside this confirm (the innermost one that
    // holds it): Escape aimed at a Select, picker or dialog elsewhere is theirs.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || confirmHolding(e.target) !== me) return;
      e.preventDefault();
      e.stopPropagation();
      onEscapeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      open.splice(open.indexOf(me), 1);
      if (!focusIsAdrift()) return;
      // A trigger disabled by the action it confirmed can't take focus.
      const usable = (el: HTMLElement | null | undefined) =>
        el?.isConnected && !(el as HTMLButtonElement).disabled ? el : undefined;
      const target = usable(asked.current) ?? usable(returnFocusRef.current?.());
      target?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      ref={root}
      role="alertdialog"
      aria-labelledby={`${id}-msg`}
      aria-describedby={note ? `${id}-note` : undefined}
      className={cn(
        'cw-confirm tile flex w-full min-w-0 flex-col gap-2 px-3 py-2.5 text-sm ring-1 ring-foreground/10',
        className,
      )}
    >
      <p className="min-w-0 text-pretty">
        <span id={`${id}-msg`} className="font-medium break-words">
          {message}
        </span>
        {note ? (
          <>
            {' '}
            <span id={`${id}-note`} className="text-muted-foreground">
              {note}
            </span>
          </>
        ) : null}
      </p>
      {details}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button ref={cancel} type="button" size="sm" variant="ghost" onClick={onCancel}>
          {cancelLabel}
        </Button>
        {children}
      </div>
    </div>
  );
}

export interface ConfirmButtonProps {
  readonly message: ReactNode;
  readonly note?: ReactNode;
  readonly details?: ReactNode;
  readonly cancelLabel?: string;
  /** Names the act: "Delete role", not "OK". */
  readonly confirmLabel: string;
  /** `destructive` (default) uses the tinted red button; `default` the ink pill. */
  readonly tone?: 'destructive' | 'default';
  /** Disables the confirming button (e.g. while another request is in flight). */
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly className?: string;
  /** Renders the trigger; call `ask` from its onClick to swap in the confirm. */
  readonly children: (ask: () => void) => ReactNode;
}

/**
 * A trigger that turns into its own {@link InlineConfirm} in place. On cancel
 * the trigger comes back with focus; on confirm, `onConfirm` runs.
 *
 * ```tsx
 * <ConfirmButton
 *   message={`Delete “${role.name}”?`}
 *   note="Keys bound to it lose its grants."
 *   confirmLabel="Delete role"
 *   busy={busy}
 *   onConfirm={() => remove(role.id)}
 * >
 *   {(ask) => <Button variant="ghost" size="sm" onClick={ask}>Delete</Button>}
 * </ConfirmButton>
 * ```
 */
export function ConfirmButton({
  message,
  note,
  details,
  cancelLabel,
  confirmLabel,
  tone = 'destructive',
  busy,
  onConfirm,
  className,
  children,
}: ConfirmButtonProps) {
  const [asking, setAsking] = useState(false);
  const slot = useRef<HTMLSpanElement>(null);
  const trigger = () =>
    slot.current?.querySelector<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])');
  return (
    <span ref={slot} className={cn(asking ? 'block w-full min-w-0' : 'contents')}>
      {asking ? (
        <InlineConfirm
          message={message}
          note={note}
          details={details}
          cancelLabel={cancelLabel}
          onCancel={() => setAsking(false)}
          returnFocus={trigger}
          className={className}
        >
          <Button
            type="button"
            size="sm"
            variant={tone}
            disabled={busy}
            onClick={() => {
              setAsking(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </InlineConfirm>
      ) : (
        children(() => setAsking(true))
      )}
    </span>
  );
}
