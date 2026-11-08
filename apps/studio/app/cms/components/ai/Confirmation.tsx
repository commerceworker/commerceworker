import { Button } from '@commerceworker/ui/button';
import type { ReactNode } from 'react';
import { InlineConfirm } from '~/cms/components/InlineConfirm';

/**
 * An agent result awaiting the editor's decision. Adapted from the AI Elements
 * Confirmation pattern (title + description + Approve/Deny actions), built on
 * the admin's own {@link InlineConfirm}: the same muted panel, focus lands on
 * the safe choice (Dismiss), Escape backs out, and it's announced as an
 * `alertdialog` labelled by the question. Nothing is written until Apply.
 *
 * `provenance` is where a {@link Task} goes (which agent, what it did);
 * `children` is the reviewable payload (proposed values, tags).
 */
export function Confirmation(props: {
  /** The question, naming what lands: "Apply 3 translated fields?" */
  title: ReactNode;
  /** One line of consequence: "Fills the form; nothing is saved until you save." */
  note?: ReactNode;
  provenance?: ReactNode;
  children?: ReactNode;
  applyLabel?: string;
  dismissLabel?: string;
  busy?: boolean;
  onApply: () => void;
  onDismiss: () => void;
  /** What Escape does, where it shouldn't throw the proposal away as Dismiss does. */
  onEscape?: () => void;
  className?: string;
}) {
  return (
    <InlineConfirm
      message={props.title}
      note={props.note}
      cancelLabel={props.dismissLabel ?? 'Dismiss'}
      onCancel={props.onDismiss}
      onEscape={props.onEscape}
      className={props.className}
      details={
        (props.provenance || props.children) && (
          <div className="min-w-0 space-y-2.5">
            {props.provenance}
            {props.children}
          </div>
        )
      }
    >
      <Button type="button" size="sm" disabled={props.busy} onClick={props.onApply}>
        {props.applyLabel ?? 'Apply'}
      </Button>
    </InlineConfirm>
  );
}

/** A proposed value, labelled by its field: the reviewable unit of a proposal. */
export function ProposedValue(props: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground text-xs">{props.label}</p>
      <p className="line-clamp-4 break-words text-sm">{props.children}</p>
    </div>
  );
}
