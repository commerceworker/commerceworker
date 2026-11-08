import type { LucideIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from './lib/utils';
import { Skeleton } from './skeleton';

export interface StatCardProps {
  label: string;
  value: string | number;
  description?: string;
  icon?: LucideIcon;
  /** When true, shows a skeleton instead of the value. */
  loading?: boolean;
  className?: string;
}

export const StatCard = React.memo(function StatCard({
  label,
  value,
  description,
  icon: Icon,
  loading,
  className,
}: StatCardProps) {
  return (
    <div
      className={cn('rounded-2xl border border-border bg-card p-5 text-card-foreground', className)}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
      </div>
      {loading ? (
        <Skeleton className="h-8 w-24 rounded-md" aria-hidden />
      ) : (
        <p className="text-2xl font-bold tabular-nums">{value}</p>
      )}
      {description && !loading ? (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
});
