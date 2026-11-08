import type * as React from 'react';
import { cn } from './lib/utils';

export interface DetailListProps {
  items: Array<{ id?: string; label: string; value: React.ReactNode }>;
  className?: string;
}

export function DetailList({ items, className }: DetailListProps) {
  return (
    <dl className={cn('divide-y divide-border', className)}>
      {items.map(({ id, label, value }) => (
        <div key={id ?? label} className="flex gap-4 py-2.5 first:pt-0 last:pb-0 sm:gap-6">
          <dt className="w-36 shrink-0 text-sm text-muted-foreground sm:w-40">{label}</dt>
          <dd className="min-w-0 text-sm text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
