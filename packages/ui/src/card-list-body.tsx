import type * as React from 'react';
import { cn } from './lib/utils';

/** Standard inset below `CardSearchBar` / `ListPageFilterStrip` before a table or list body. */
export function CardListBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-2 pt-3 pb-2', className)} {...props} />;
}
