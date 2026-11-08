import type * as React from 'react';
import { Badge, type BadgeProps } from './badge';
import { cn } from './lib/utils';
import { Spinner } from './spinner';

export interface LoadingStatusBadgeProps extends Omit<BadgeProps, 'children'> {
  /** When true, shows a small spinner and `pendingLabel`. */
  pending: boolean;
  /** Shown while `pending` is true. */
  pendingLabel?: string;
  /** Shown while `pending` is false (optional if the badge is only used while pending). */
  children?: React.ReactNode;
  /** Badge `variant` when idle; defaults to the same `variant` as pending. */
  idleVariant?: BadgeProps['variant'];
}

/**
 * shadcn-style status chip: idle label vs “Updating…” (or custom) with inline spinner.
 * Use for refetch/mutation feedback next to section titles or in list rows.
 */
export function LoadingStatusBadge({
  pending,
  pendingLabel = 'Updating…',
  className,
  children,
  variant = 'secondary',
  idleVariant,
  ...badgeProps
}: LoadingStatusBadgeProps) {
  if (!pending && (children === undefined || children === null)) {
    return null;
  }
  const effectiveVariant = pending ? variant : (idleVariant ?? variant);
  return (
    <Badge
      variant={effectiveVariant}
      className={cn('inline-flex items-center gap-1.5 font-normal', className)}
      {...badgeProps}
    >
      {pending ? <Spinner className="size-3 shrink-0" aria-hidden /> : null}
      <span className="tabular-nums">{pending ? pendingLabel : (children ?? null)}</span>
    </Badge>
  );
}
