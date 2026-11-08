import type { Column } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type * as React from 'react';
import { Button } from './button';
import { cn } from './lib/utils';

interface DataTableColumnHeaderProps<TData, TValue> extends React.HTMLAttributes<HTMLDivElement> {
  column: Column<TData, TValue>;
  title: string;
}

export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
  className,
}: DataTableColumnHeaderProps<TData, TValue>) {
  // A numeric column is right-aligned, so the ghost button's optical offset and
  // the sort affordance both mirror; otherwise the label would sit inset from
  // the digits it heads.
  const numeric = column.columnDef.meta?.numeric === true;

  if (!column.getCanSort()) {
    return <div className={cn(numeric && 'text-right', className)}>{title}</div>;
  }

  const sorted = column.getIsSorted();

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(numeric ? '-mr-3 ml-auto' : '-ml-3', className)}
      onClick={() => column.toggleSorting(sorted === 'asc')}
    >
      {title}
      {sorted === 'desc' ? (
        <ArrowDown className="ml-1.5 size-3.5" />
      ) : sorted === 'asc' ? (
        <ArrowUp className="ml-1.5 size-3.5" />
      ) : (
        <ArrowUpDown className="ml-1.5 size-3.5 text-muted-foreground/50" />
      )}
    </Button>
  );
}
