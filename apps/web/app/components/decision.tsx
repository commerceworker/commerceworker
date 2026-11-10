/**
 * Approve / reject with a note. Pressing one asks for it through the assistant: its confirm card
 * states what the decision does, and the decision is recorded only once the person confirms there.
 * Shared by the approvals inbox and the order page.
 */

import { Button } from '@commerceworker/ui/button';
import { Field, FieldLabel } from '@commerceworker/ui/field';
import { useDateTime } from '@commerceworker/ui/hooks/use-date-time';
import { useNow } from '@commerceworker/ui/hooks/use-now';
import { Input } from '@commerceworker/ui/input';
import { until } from '@commerceworker/ui/lib/format';
import { cn } from '@commerceworker/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Check, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { type ApprovalContext, deadlineWords, lockAt, WARN_MS } from '~/lib/approvals';

export type Decision = 'approved' | 'rejected';

const noSubscribe = () => () => {};

/**
 * The deadline, said first: "Decide in 3m", "Closes 2:05 PM", "Decisions close in 8s". Muted while
 * there is time and ink in the last ten seconds; never amber, which is for overdue ages. The full
 * time is in the tooltip.
 */
export function DecisionDeadline({
  deadline,
  onTimeout,
  className,
}: {
  deadline: number;
  /** Where the order goes if nobody decides, for the closed line. */
  onTimeout?: string;
  className?: string;
}) {
  const now = useNow(1000);
  const formatTime = useDateTime();
  // The server can't know the viewer's zone: it and the hydrating render say UTC, then local.
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const w = deadlineWords(deadline, now, hydrated ? undefined : 'UTC');
  return (
    <span
      className={cn(
        'tabular',
        w.kind === 'soon' ? 'font-medium text-foreground' : 'text-muted-foreground',
        className,
      )}
      title={formatTime(deadline)}
      suppressHydrationWarning
    >
      {w.kind === 'closed'
        ? `Decisions closed${onTimeout ? `; it goes to ${onTimeout}` : ''}`
        : w.kind === 'soon'
          ? `Decisions close ${w.when}`
          : w.kind === 'in'
            ? `Decide ${w.when}`
            : `Closes ${w.when}`}
    </span>
  );
}

/**
 * Why a person is asked, the figures behind it, what the order is for, the approvals before this
 * one, and the escalation clock.
 */
export function DecisionContext({
  ctx,
  className,
  clock = true,
  reason = true,
}: {
  ctx: ApprovalContext;
  className?: string;
  /** Show the escalation clock; off once the approval is no longer open. */
  clock?: boolean;
  /** Show the reason line; off where the row already says it. */
  reason?: boolean;
}) {
  const now = useNow(clock && ctx.deadline ? 1000 : null);
  const formatTime = useDateTime();
  const ticking = clock && ctx.deadline !== undefined && lockAt(ctx.deadline) > now;
  const said = reason ? ctx.reason : undefined;
  if (!said && !ctx.facts.length && !ctx.lines && !ctx.trail.length && !ticking) return null;
  return (
    <div className={cn('space-y-0.5 text-sm', className)}>
      {said ? <p className="font-medium text-foreground">{said}</p> : null}
      {ctx.facts.length ? (
        <p className="max-w-[72ch] text-muted-foreground text-xs tabular">
          {ctx.facts.join(' · ')}
        </p>
      ) : null}
      {ctx.lines ? (
        <p className="max-w-[72ch] truncate text-muted-foreground text-xs" title={ctx.lines}>
          For {ctx.lines}
        </p>
      ) : null}
      {ctx.trail.length ? (
        <p className="max-w-[72ch] text-muted-foreground text-xs">
          Before this: {ctx.trail.join(', then ')}
        </p>
      ) : null}
      {/* The clock counts to when decisions close, the moment that matters to the person deciding;
          once closed, the controls say what happens next. A deadline still ahead is muted: amber
          is for one that has passed. */}
      {ticking && ctx.deadline ? (
        <p
          className="text-muted-foreground text-xs"
          title={formatTime(ctx.deadline)}
          suppressHydrationWarning
        >
          {lockAt(ctx.deadline) - now <= WARN_MS
            ? `Decisions close ${until(lockAt(ctx.deadline), now)}${ctx.onTimeout ? `, then it goes to ${ctx.onTimeout}` : ''}`
            : ctx.onTimeout
              ? `If no one decides ${until(lockAt(ctx.deadline), now)}, it goes to ${ctx.onTimeout}`
              : `Times out ${until(lockAt(ctx.deadline), now)}`}
        </p>
      ) : null}
    </div>
  );
}

export function DecisionControls({
  onDecide,
  deadline,
  onTimeout,
  disabled,
  busy,
  compact,
  shortcuts,
  label,
  defaultNote = '',
  withNote = true,
  members,
}: {
  /**
   * Asks for the decision: the assistant's confirm card says what it does and records it.
   * `onBehalfOf` is the member whose vote it is, when `members` were offered.
   */
  onDecide: (decision: Decision, note: string, onBehalfOf?: string) => void;
  /**
   * A company approval is voted by its members, and staff record the vote for one (docs/b2b.md,
   * D3): who, to choose from. The buttons wait until one is chosen.
   */
  members?: { id: string; name: string }[];
  /** When the step times out. Decisions close just before it. */
  deadline?: number;
  /** What the flow does on timeout, e.g. "Decline order". */
  onTimeout?: string;
  disabled?: boolean;
  /** The decision waits on its card, or is being recorded. */
  busy?: boolean;
  compact?: boolean;
  /** Listen for A / R on this element's row (inbox keyboard path). */
  shortcuts?: React.RefObject<HTMLElement | null>;
  /** What the buttons decide, for their accessible names, e.g. "#agszfp, $9,760.00". */
  label?: string;
  defaultNote?: string;
  /** Show the note field. Hidden, a note already typed is kept and still sent. */
  withNote?: boolean;
}) {
  const [note, setNote] = useState(defaultNote);
  const [member, setMember] = useState('');
  // Near the deadline, tick so the controls lock before a decision could arrive too late.
  const nearDeadline = deadline !== undefined && deadline - Date.now() < 60_000;
  const now = useNow(nearDeadline ? 1000 : null);
  const locked = deadline !== undefined && now > lockAt(deadline);
  const warning = deadline !== undefined && !locked && lockAt(deadline) - now <= WARN_MS;
  const rootRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef<HTMLParagraphElement>(null);
  // When decisions close under someone's focus, hand it to the message that says why. Track focus
  // ourselves: the browser drops it from a control the moment that control is disabled.
  const focusWithin = useRef(false);
  useEffect(() => {
    // Focus moving anywhere fires focusin; focus dropped because a control was disabled doesn't,
    // so the last place it went still tells us whether it was in this card.
    const onIn = (e: FocusEvent) => {
      focusWithin.current = !!rootRef.current?.contains(e.target as Node);
    };
    document.addEventListener('focusin', onIn);
    return () => document.removeEventListener('focusin', onIn);
  }, []);
  useEffect(() => {
    if (locked && focusWithin.current) closedRef.current?.focus();
  }, [locked]);
  const noteId = useId();
  const memberId = useId();
  const latest = useRef({ onDecide, note, member, closed: false });
  const needsMember = !!members && !member;
  latest.current = {
    onDecide,
    note,
    member,
    closed: !!(disabled || busy || locked || needsMember),
  };
  const decide = (decision: Decision) => {
    const l = latest.current;
    if (!l.closed) l.onDecide(decision, l.note.trim(), l.member || undefined);
  };

  useEffect(() => {
    const el = shortcuts?.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      // A row's selection checkbox is still the row; a text field is not.
      const typing = e.target instanceof HTMLInputElement && e.target.type !== 'checkbox';
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'a' || k === 'r') {
        e.preventDefault();
        decide(k === 'a' ? 'approved' : 'rejected');
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [shortcuts]);

  if (busy) {
    return (
      <p className="animate-arrive text-muted-foreground text-sm" aria-live="polite">
        Confirm it in the assistant
      </p>
    );
  }

  // Closed decisions keep the controls (and any note) in place, disabled, under one line that
  // says what happens next, in ink: amber is for overdue ages. Ten seconds before, screen readers
  // hear it once. (The inbox moves a closed row out of its queue instead.)
  return (
    <div ref={rootRef} className="space-y-2">
      {locked ? (
        <p
          ref={closedRef}
          tabIndex={-1}
          role="status"
          className="font-medium text-foreground text-sm outline-none"
        >
          Decisions are closed;{' '}
          {onTimeout ? `the order is going to ${onTimeout}` : 'the step is timing out'}.
        </p>
      ) : (
        <span className="sr-only" aria-live="polite">
          {warning ? 'Ten seconds left to decide.' : ''}
        </span>
      )}
      {members ? (
        <Field data-disabled={disabled || locked || undefined} className="gap-1">
          <FieldLabel htmlFor={memberId} className="text-muted-foreground text-xs">
            Recording the vote of
          </FieldLabel>
          <NativeSelect
            id={memberId}
            size="sm"
            wrapperClassName="w-full"
            value={member}
            onChange={(e) => setMember(e.target.value)}
            disabled={disabled || locked}
          >
            <NativeSelectOption value="">Choose a member</NativeSelectOption>
            {members.map((m) => (
              <NativeSelectOption key={m.id} value={m.id}>
                {m.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      <DecisionForm
        compact={compact}
        noteId={noteId}
        note={note}
        setNote={setNote}
        disabled={disabled || locked || needsMember}
        decide={decide}
        label={label}
        withNote={withNote}
      />
    </div>
  );
}

function DecisionForm({
  compact,
  noteId,
  note,
  setNote,
  disabled,
  decide,
  label,
  withNote,
}: {
  compact?: boolean;
  noteId: string;
  note: string;
  setNote: (note: string) => void;
  disabled?: boolean;
  decide: (decision: Decision) => void;
  label?: string;
  withNote?: boolean;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', compact && 'sm:flex-nowrap')}>
      {withNote ? (
        <Field
          data-disabled={disabled || undefined}
          className={cn('gap-0', compact ? 'w-full sm:w-48' : 'w-full')}
        >
          <FieldLabel htmlFor={noteId} className="sr-only">
            Note for the order history
          </FieldLabel>
          <Input
            id={noteId}
            placeholder="Note (optional)"
            className="h-8 text-sm"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={disabled}
          />
        </Field>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => decide('approved')}
          aria-label={label ? `Approve ${label}` : undefined}
          aria-keyshortcuts="A"
        >
          <Check aria-hidden="true" /> Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => decide('rejected')}
          aria-label={label ? `Reject ${label}` : undefined}
          aria-keyshortcuts="R"
        >
          <X aria-hidden="true" /> Reject
        </Button>
      </div>
    </div>
  );
}
