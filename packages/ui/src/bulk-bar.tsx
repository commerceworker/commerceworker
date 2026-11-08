import { X } from 'lucide-react';
import type * as React from 'react';

import { Button } from './button';
import { cn } from './lib/utils';

/**
 * What can be done to a list's ticked rows at once: the count first, the actions, then Clear at the
 * end. One bar for every list that ticks rows, so a bulk action is always found in the same place.
 * `note` says why something offered can't run.
 */
function BulkBar({
  label,
  count,
  onClear,
  note,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  /** Names the group for screen readers ("Selected entries"). */
  label: string;
  count: number;
  onClear: () => void;
  note?: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a form fieldset
    <div
      role="group"
      aria-label={label}
      data-slot="bulk-bar"
      className={cn(
        'flex min-h-12 flex-wrap items-center gap-2 rounded-2xl bg-muted px-3 py-2 animate-arrive',
        className,
      )}
      {...props}
    >
      <span className="text-muted-foreground text-sm tabular">{count} selected</span>
      {children}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="ml-auto"
        onClick={onClear}
        aria-label="Clear selection"
      >
        <X aria-hidden="true" />
        Clear
      </Button>
      {note}
    </div>
  );
}

export { BulkBar };
