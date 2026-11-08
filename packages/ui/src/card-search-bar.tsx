import type { LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { InputGroup, InputGroupAddon, InputGroupInput } from './input-group';
import { cn } from './lib/utils';

/**
 * Full-width search row for card headers (InputGroup + optional icon + trailing summary).
 * Often composed inside {@link ListPageFilterStripPrimary}.
 */
export function CardSearchBar({
  icon: Icon,
  className,
  addonClassName,
  trailing,
  ...props
}: React.ComponentProps<typeof InputGroupInput> & {
  icon?: LucideIcon;
  addonClassName?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <InputGroup
      className={cn(
        'h-auto min-h-11 rounded-none border-0 border-b border-border bg-transparent py-0 shadow-none dark:bg-transparent',
        className,
      )}
    >
      {Icon ? (
        <InputGroupAddon align="inline-start" className={cn('pl-4 pr-0', addonClassName)}>
          <Icon className="text-muted-foreground" />
        </InputGroupAddon>
      ) : null}
      <InputGroupInput className={cn('h-11 py-2.5', trailing ? 'pr-2' : 'pr-4')} {...props} />
      {trailing ? (
        <InputGroupAddon
          align="inline-end"
          className="shrink-0 pr-4 text-xs text-muted-foreground tabular-nums"
        >
          {trailing}
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}
