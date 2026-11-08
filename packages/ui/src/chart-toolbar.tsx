import type * as React from 'react';
import { cn } from './lib/utils';

export function ChartToolbar({
  title,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
      {...props}
    >
      <div className="text-base font-medium text-foreground">{title}</div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}
