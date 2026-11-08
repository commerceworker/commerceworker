import type * as React from 'react';
import { cn } from './lib/utils';
import { Separator } from './separator';

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Trailing actions (buttons, etc.) aligned with the title row on wide screens. */
  actions?: React.ReactNode;
  className?: string;
  /** When false, the bottom separator is omitted. Default true. */
  showSeparator?: boolean;
}

/**
 * Consistent page title + description + optional actions, matching shadcn dashboard block patterns.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
  showSeparator = true,
}: PageHeaderProps) {
  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:pt-0.5">
            {actions}
          </div>
        ) : null}
      </div>
      {showSeparator ? <Separator /> : null}
    </div>
  );
}
