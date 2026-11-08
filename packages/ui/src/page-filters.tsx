import type * as React from 'react';
import { cn } from './lib/utils';

/** Use on `Field` (or a wrapper `div`) so controls don’t stretch to full row width on large screens. */
export const pageFilterFieldClassName = 'w-full min-w-0 sm:w-auto sm:min-w-[11rem] sm:max-w-md';

/** Short inputs (coordinates, small numbers). */
export const pageFilterFieldNarrowClassName =
  'w-full min-w-0 sm:w-auto sm:min-w-[8.5rem] sm:max-w-[11rem]';

/**
 * `Field` shell for platform tenant combobox in filter toolbars (room for “Name (slug)”).
 * The control-ui `TenantCombobox` already merges {@link tenantComboboxWidthClassName}.
 */
export const pageFilterTenantFieldClassName =
  'w-full min-w-0 sm:w-auto sm:min-w-[22rem] sm:max-w-2xl';

/** Default trigger width for control plane tenant pickers (`Combobox` / `TenantCombobox`). */
export const tenantComboboxWidthClassName = 'w-full min-w-0 sm:min-w-[22rem] sm:max-w-2xl';

/**
 * Horizontal filter row: stacks on small viewports, aligns in a row with wrapping on `sm+`.
 * Pair with {@link pageFilterFieldClassName} on each `Field`.
 */
export function PageFiltersToolbar({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="page-filters-toolbar"
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-4 sm:gap-y-3',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Card header strip: primary search (flex-1) + aside filters (fixed min width), matching the orders list pattern.
 */
export function ListPageFilterStrip({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="list-page-filter-strip"
      className={cn(
        'flex flex-col gap-0 border-b border-border sm:flex-row sm:items-stretch',
        className,
      )}
      {...props}
    />
  );
}

export function ListPageFilterStripPrimary({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="list-page-filter-strip-primary"
      className={cn('min-w-0 flex-1 sm:border-r sm:border-border sm:border-b-0', className)}
      {...props}
    />
  );
}

export function ListPageFilterStripAside({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="list-page-filter-strip-aside"
      className={cn(
        'flex items-center px-4 py-2 sm:w-52 sm:min-w-[12rem] sm:shrink-0 sm:py-0',
        className,
      )}
      {...props}
    />
  );
}
