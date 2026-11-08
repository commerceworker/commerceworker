import { cn } from '@commerceworker/ui/lib/utils';
import { ChevronDown } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';

/**
 * Provenance for an agent result: which agent ran, the steps it took, and what
 * it proposes. Adapted from the AI Elements Task/Trace pattern (copy-in, no
 * package) onto the admin's tokens: a quiet disclosure row, steps as a
 * hairline-ruled list, 12px labels, no colour (nothing here is a state).
 *
 * ```tsx
 * <Task title="AI assist · Translate → fr" defaultOpen>
 *   <TaskItem>Read 3 localized text fields</TaskItem>
 *   <TaskItem>Translated en-US → fr</TaskItem>
 * </Task>
 * ```
 */
export function Task(props: {
  /** Who did it and what: "AI assist · Summarize → Excerpt". */
  title: ReactNode;
  /** Optional trailing meta on the trigger row (tier, token count). */
  meta?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root defaultOpen={props.defaultOpen} className={cn('min-w-0', props.className)}>
      <Collapsible.Trigger className="group flex w-full min-w-0 items-center gap-2 rounded-md text-left text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-0 flex-1 truncate font-medium">{props.title}</span>
        {props.meta && <span className="shrink-0 tabular-nums">{props.meta}</span>}
        <ChevronDown
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
        />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ol className="mt-1.5 space-y-1 border-border border-l pl-3">{props.children}</ol>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/** One step the agent took. Plain text; the list's rule carries the sequence. */
export function TaskItem(props: { children: ReactNode }) {
  return <li className="text-muted-foreground text-xs">{props.children}</li>;
}
