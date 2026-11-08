import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@commerceworker/ui/card';
import {
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  Empty as EmptyRoot,
  EmptyTitle,
} from '@commerceworker/ui/empty';
import { cn } from '@commerceworker/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';

/*
 * A page's parts. The shell's <main>
 * already lays out the page body (`Body`: the page width and gutters), so `PageHeader` brings only
 * its vertical rhythm, not a second set of gutters.
 */

/**
 * A page's h1 (the title tier: 600, 1.75rem, tracking-title; it wraps, never truncates), an
 * optional intro held to the measure, and the page's actions at the right. `description` and
 * `children` are the earlier names of `subtitle` and `actions`.
 */
export function PageHeader({
  title,
  subtitle,
  description,
  actions,
  children,
  crumbs,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  crumbs?: React.ReactNode;
}) {
  const intro = subtitle ?? description;
  const act = actions ?? children;
  return (
    <header className="flex w-full flex-wrap items-end justify-between gap-3 pt-3 pb-5 sm:pt-5">
      <div className="min-w-0">
        {crumbs ? <div className="caption mb-1">{crumbs}</div> : null}
        <h1 className="break-words font-semibold text-[1.75rem] leading-tight tracking-title">
          {title}
        </h1>
        {intro ? <p className="mt-1 max-w-measure text-muted-foreground text-sm">{intro}</p> : null}
      </div>
      {act ? <div className="flex flex-wrap items-center gap-2">{act}</div> : null}
    </header>
  );
}

/** Page body width (the shell wraps every page in it). */
export function Body({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full min-w-0 max-w-page px-4 pb-10 sm:px-6', className)}>
      {children}
    </div>
  );
}

/**
 * A card with a title (Maia's Card: CardHeader, CardTitle, CardAction, CardContent). `flush` lets
 * content that brings its own rows (tables, ruled lists) run to the card's edges under a rule.
 */
export function Section({
  id,
  title,
  description,
  children,
  className,
  actions,
  flush,
}: {
  /** An in-page link target; it clears the sticky header when jumped to. */
  id?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
  /** Drop the body padding for content that brings its own rows (tables, ruled lists). */
  flush?: boolean;
}) {
  return (
    <Card
      id={id}
      className={cn(
        // Clip, not hidden: hidden would make the card a scroll container and stop a sticky table
        // header at its top. Relative, so it also clips what's positioned inside it.
        'relative min-w-0 scroll-mt-[calc(var(--shell-h)+1rem)] gap-4 overflow-clip [--card-spacing:--spacing(5)]',
        flush && 'pb-0',
        className,
      )}
    >
      {/* On a phone a description beside the actions would wrap a word to a line: the actions go
          under it instead. */}
      <CardHeader className={cn(description && actions && 'max-sm:grid-cols-1!')}>
        <CardTitle className="section-title">
          <h2>{title}</h2>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {actions ? (
          <CardAction
            className={cn(
              'self-center',
              description &&
                'max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-auto max-sm:justify-self-start',
            )}
          >
            {actions}
          </CardAction>
        ) : null}
      </CardHeader>
      {flush ? <div className="border-t">{children}</div> : <CardContent>{children}</CardContent>}
    </Card>
  );
}

/**
 * An empty state (Maia's Empty): what is (not) here, and optionally the next useful step. Inside a
 * card it stays compact; give it an `icon` and a `title` where the empty state is the page's news.
 */
export function Empty({
  children,
  action,
  icon,
  title,
  className,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  title?: React.ReactNode;
  className?: string;
}) {
  return (
    <EmptyRoot className={cn('gap-3 p-6', className)}>
      <EmptyHeader className="max-w-measure">
        {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
        {title ? <EmptyTitle className="font-semibold text-base">{title}</EmptyTitle> : null}
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </EmptyRoot>
  );
}

/**
 * `Empty` with an icon component and a title: the earlier EmptyState signature, kept for the
 * screens that name the news ("No releases yet").
 */
export function EmptyState(props: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const { icon: Icon } = props;
  return (
    <Empty
      icon={<Icon />}
      title={props.title}
      action={props.children}
      className={cn('card', props.className)}
    >
      {props.description}
    </Empty>
  );
}
