import { Field, FieldDescription, FieldLabel } from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { cn } from '@commerceworker/ui/lib/utils';
import type { ReactNode } from 'react';
import type { ShownIssue } from '~/lib/checkout-form';

/** The id of the input a field of the form is. */
export const fieldId = (name: string) => `f-${name.replace(/[^a-z0-9]/gi, '-')}`;

/** A field's own message: in the destructive tone and tied to its input, not announced by itself (the page's alert is). */
export function FieldMessage({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-sm text-destructive">
      {children}
    </p>
  );
}

/**
 * A field of the checkout form: its label, a 44px, 16px input (the sizes a thumb and iOS need, on
 * every screen, not only touch ones), and what is wrong with it. `autoComplete` is the token a
 * browser fills it by. The error is tied to the input (`aria-describedby`), so a screen reader
 * says it with the field. `errorBelow` leaves the message to the caller, for a field in a row with
 * a button, where a message under the input alone would push the row out of line.
 */
export function TextField({
  name,
  label,
  defaultValue,
  error,
  errorBelow,
  hint,
  autoComplete,
  type = 'text',
  inputMode,
  required,
  optional,
  maxLength,
  className,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  error?: string | undefined;
  /** The id of a message the caller shows elsewhere, which this input is invalid by. */
  errorBelow?: string;
  hint?: ReactNode;
  autoComplete?: string;
  type?: 'text' | 'email' | 'tel' | 'number';
  inputMode?: 'text' | 'email' | 'tel' | 'numeric';
  required?: boolean;
  optional?: boolean;
  maxLength?: number;
  className?: string;
}) {
  const id = fieldId(name);
  const described = [
    error ? `${id}-error` : null,
    errorBelow ?? null,
    hint ? `${id}-hint` : null,
  ].filter(Boolean);
  return (
    <Field
      data-invalid={error || errorBelow ? true : undefined}
      className={cn('gap-1.5', className)}
    >
      <FieldLabel htmlFor={id}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
      </FieldLabel>
      <Input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue ?? ''}
        autoComplete={autoComplete}
        inputMode={inputMode}
        required={required}
        maxLength={maxLength}
        aria-invalid={error || errorBelow ? true : undefined}
        aria-describedby={described.length ? described.join(' ') : undefined}
        // Always 16px (iOS zooms into anything smaller, and `md:text-sm` would shrink it on a desktop).
        className="h-11 text-base md:text-base"
        {...(type === 'email' ? { autoCapitalize: 'none', spellCheck: false } : {})}
      />
      {hint ? (
        <FieldDescription id={`${id}-hint`} className="text-xs">
          {hint}
        </FieldDescription>
      ) : null}
      {error ? <FieldMessage id={`${id}-error`}>{error}</FieldMessage> : null}
    </Field>
  );
}

/**
 * A native radio row, 44px or more tall whole (the label is the target), drawn with the brand's
 * tint when chosen. Native, so the choice posts with the form and works without a script.
 */
export function RadioRow({
  name,
  value,
  checked,
  children,
  aside,
}: {
  name: string;
  value: string;
  checked: boolean;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border bg-card px-3 py-2 has-[:checked]:border-brand has-[:checked]:bg-brand-subtle has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30">
      <input type="radio" name={name} value={value} defaultChecked={checked} />
      <span className="min-w-0 flex-1">{children}</span>
      {aside ? <span className="shrink-0 tabular-nums">{aside}</span> : null}
    </label>
  );
}

/**
 * Issues under a section's heading. Errors and warnings are in words (a "Fix:" or "Note:" prefix),
 * not colour alone, and only an error is in the destructive tone: a warning is ink.
 */
export function IssueList({ issues, id }: { issues: ShownIssue[]; id?: string }) {
  if (!issues.length) return null;
  return (
    <ul id={id} className="flex flex-col gap-1 text-sm">
      {issues.map((i) => (
        <li
          key={`${i.kind}:${i.content}`}
          className={i.kind === 'error' ? 'text-destructive' : 'text-foreground'}
        >
          {i.todo ? null : (
            <span className="font-medium">{i.kind === 'error' ? 'Fix: ' : 'Note: '}</span>
          )}
          {i.content}
        </li>
      ))}
    </ul>
  );
}
