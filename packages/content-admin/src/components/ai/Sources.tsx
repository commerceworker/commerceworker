import { Link } from '@commerceworker/content-admin/router';
import { cn } from '@commerceworker/ui/lib/utils';
import { ChevronDown } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { type ReactNode, useId, useState } from 'react';

/**
 * A collapsed list of sources behind a one-line summary. Adapted from the AI
 * Elements Sources / Inline Citation patterns: the trigger states the count,
 * each source is one line (title link + measure), and its excerpt is revealed
 * on demand instead of being dumped inline.
 */
export function Sources(props: {
  /** The one-line summary, e.g. a badge + "2 possible duplicates". */
  summary: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root defaultOpen={props.defaultOpen} className={cn('min-w-0', props.className)}>
      <Collapsible.Trigger className="group flex w-full min-w-0 items-center gap-2 rounded-md text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex min-w-0 flex-1 items-center gap-2">{props.summary}</span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
        />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <ul className="mt-2 space-y-1">{props.children}</ul>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/**
 * One source: a single line with the title (linked when we know where it
 * lives) and a measure (e.g. "93% similar"). The excerpt, when there is one,
 * sits behind a disclosure toggle — the keyboard/touch-safe equivalent of the
 * Inline Citation hover card.
 */
export function Source(props: {
  title: string;
  to?: string | null;
  measure?: ReactNode;
  excerpt?: string;
}) {
  const [open, setOpen] = useState(false);
  const excerptId = useId();
  const hasExcerpt = Boolean(props.excerpt?.trim());
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {props.to ? (
          <Link
            to={props.to}
            className="min-w-0 flex-1 truncate underline-offset-2 hover:underline"
            title={props.title}
          >
            {props.title}
          </Link>
        ) : (
          <span className="min-w-0 flex-1 truncate" title={props.title}>
            {props.title}
          </span>
        )}
        {props.measure && (
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {props.measure}
          </span>
        )}
        {hasExcerpt && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={excerptId}
            aria-label={`${open ? 'Hide' : 'Show'} excerpt from ${props.title}`}
            onClick={() => setOpen((o) => !o)}
            className="group shrink-0 rounded-md p-0.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              aria-hidden
              className={cn(
                'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
                open && 'rotate-180',
              )}
            />
          </button>
        )}
      </div>
      {hasExcerpt && open && (
        <p
          id={excerptId}
          className="mt-1 line-clamp-3 rounded-lg bg-muted px-2 py-1.5 text-muted-foreground text-xs"
        >
          {props.excerpt}
        </p>
      )}
    </li>
  );
}
