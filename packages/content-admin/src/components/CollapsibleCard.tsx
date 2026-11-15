import { Card, CardContent, CardHeader } from '@commerceworker/ui/card';
import { cn } from '@commerceworker/ui/lib/utils';
import { ChevronDown } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';

/**
 * A rail panel: a Card whose header row toggles the body. The whole header is
 * the trigger (accordion pattern: a button inside the h2), so panels collapse
 * without a second chrome layer. Closed panels unmount their body, which also
 * defers their data fetches until first opened.
 */
export function CollapsibleCard(props: {
  title: ReactNode;
  /** Optional muted line under the title, visible even when collapsed. */
  description?: ReactNode;
  defaultOpen?: boolean;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root defaultOpen={props.defaultOpen}>
      <Card>
        <CardHeader>
          <h2 className="font-heading font-medium text-base">
            <Collapsible.Trigger className="group flex w-full items-center justify-between gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="flex items-center gap-2">{props.title}</span>
              <ChevronDown
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180"
              />
            </Collapsible.Trigger>
          </h2>
          {props.description && (
            <p className="text-muted-foreground text-sm">{props.description}</p>
          )}
        </CardHeader>
        <Collapsible.Content>
          <CardContent className={cn(props.contentClassName)}>{props.children}</CardContent>
        </Collapsible.Content>
      </Card>
    </Collapsible.Root>
  );
}
