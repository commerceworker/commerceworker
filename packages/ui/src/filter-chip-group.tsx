'use client';

import { CheckIcon } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useId, useState } from 'react';
import { cn } from './lib/utils';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

export interface FilterChipOption<TValue extends string = string> {
  value: TValue;
  label: React.ReactNode;
  /**
   * Accessible name for the chip. Required when `label` is not plain text — a chip
   * whose visible label is a node has no readable name without it.
   */
  ariaLabel?: string;
}

export interface FilterChipGroupProps<TValue extends string = string> {
  /** Names what the chips narrow, e.g. “Filter by surface”. Always visible. */
  label: React.ReactNode;
  /** Explains what an empty selection means. Wired to the group as `aria-describedby`. */
  description?: React.ReactNode;
  options: readonly FilterChipOption<TValue>[];
  /** Empty set = no filter applied. The caller decides what that means for its list. */
  selected: ReadonlySet<TValue>;
  onChange: (next: Set<TValue>) => void;
  /** Extra classes per chip — `font-mono` for code-shaped values such as plan codes. */
  chipClassName?: string;
  className?: string;
}

/**
 * A wrapping row of multi-select filter chips under a visible group label.
 *
 * Selection is the accent's job (DESIGN.md, the One Voice Rule), so a selected chip takes
 * the cobalt state layer rather than a Panel Ink fill — an ink-filled chip reads as a
 * primary action, and a row of them out-shouts the data it filters.
 *
 * Selection is never carried by colour alone: a selected chip gains a leading check. The
 * check is only in the layout when it is showing — reserving its width on every chip leaves
 * a visible blank indent on the unselected majority, which costs more than the small
 * re-flow it avoids. `data-icon="inline-start"` lets the toggle's own size variant tighten
 * the leading padding when the check is present.
 *
 * Built on `ToggleGroup type="multiple"`, so the whole row is one tab stop with arrow-key
 * movement between chips instead of one tab stop per chip.
 */
export function FilterChipGroup<TValue extends string = string>({
  label,
  description,
  options,
  selected,
  onChange,
  chipClassName,
  className,
}: FilterChipGroupProps<TValue>) {
  const labelId = useId();
  const descriptionId = useId();

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <p className="text-xs font-medium text-foreground" id={labelId}>
        {label}
      </p>
      {description ? (
        <p className="text-sm leading-normal text-muted-foreground" id={descriptionId}>
          {description}
        </p>
      ) : null}
      <ToggleGroup
        type="multiple"
        variant="outline"
        size="sm"
        value={[...selected]}
        onValueChange={(next: string[]) => onChange(new Set(next as TValue[]))}
        aria-labelledby={labelId}
        {...(description ? { 'aria-describedby': descriptionId } : {})}
        className="w-full flex-wrap"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            {...(option.ariaLabel ? { 'aria-label': option.ariaLabel } : {})}
            className={cn(
              'gap-1.5 text-xs font-normal text-muted-foreground',
              // `toggleVariants` paints the pressed state with the neutral hover surface and
              // repaints it on hover. Both have to be overridden, or a selected chip loses the
              // accent the moment the pointer lands on it.
              'aria-pressed:bg-brand-subtle data-[state=on]:border-brand data-[state=on]:bg-brand-subtle data-[state=on]:text-brand',
              'data-[state=on]:hover:bg-brand-subtle data-[state=on]:hover:text-brand',
              chipClassName,
            )}
          >
            {selected.has(option.value) ? (
              <CheckIcon aria-hidden="true" data-icon="inline-start" className="size-3.5" />
            ) : null}
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * Selection state for {@link FilterChipGroup}. An empty set means “no filter”, which every
 * call site reads as “show everything” rather than “show nothing”.
 */
export function useFilterChips<TValue extends string = string>(initial?: Iterable<TValue>) {
  const [selected, setSelected] = useState<Set<TValue>>(() => new Set(initial));
  const clear = useCallback(() => setSelected(new Set<TValue>()), []);
  return { selected, setSelected, clear };
}
