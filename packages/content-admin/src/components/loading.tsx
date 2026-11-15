import { Card, CardContent, CardHeader, CardTitle } from '@commerceworker/ui/card';
import { cn } from '@commerceworker/ui/lib/utils';
import { SkeletonPill, SkeletonText } from '@commerceworker/ui/skeleton';
import { PageHeader } from './page';

/*
 * How a CMS screen says it's loading. The rule (DESIGN.md, The Drawn Page Rule): draw everything
 * already known for real (the title, the column headers, a sheet's header) and stand a skeleton in
 * only for the data, in the shape and size of what will replace it. No region ever says
 * "Loading…" on screen; it says so once to assistive technology, through `LoadingStatus`.
 */

/** The one announcement a loading region makes ("Loading entries…"); the skeletons are hidden. */
export function LoadingStatus({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="sr-only">
      {children}
    </p>
  );
}

/**
 * Rows already on screen while a new query runs: they stay put and readable, the region is
 * `aria-busy`, and only if the answer is slow do they settle back and a link-blue rule sweeps its
 * top edge (`.cw-refreshing` in app.css).
 */
export function Refreshing({
  busy,
  children,
  className,
}: {
  busy: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div aria-busy={busy || undefined} className={cn('cw-refreshing', className)}>
      {busy ? (
        <div className="cw-refreshing-bar" aria-hidden="true">
          <div className="cw-pending h-full w-2/5 bg-link" />
        </div>
      ) : null}
      {children}
    </div>
  );
}

/*
 * How many rows a list showed last time, so its skeleton comes back the same length. Kept for the
 * session only (a reload starts from the default): a count from last week is no better a guess.
 */
const lastCounts = new Map<string, number>();

/** The skeleton length for a list: what it last showed, held to 1–`max`, else `fallback`. */
export function rememberedCount(key: string, fallback = 6, max = 12): number {
  const n = lastCounts.get(key);
  return n === undefined ? fallback : Math.min(Math.max(n, 1), max);
}

/** Record what a list showed (call it once its data has arrived). */
export function rememberCount(key: string, count: number) {
  lastCounts.set(key, count);
}

/**
 * A CMS page before its scope is known: the page's real title, an intro line, then a section of
 * ruled rows (the shape most pages open with). The page draws its own header once it renders,
 * in the same place.
 */
export function PageSkeleton({
  title,
  label = typeof title === 'string' ? title : 'the page',
}: {
  /** The page's title, drawn for real; a skeleton line when even that isn't known yet. */
  title: React.ReactNode;
  /** What's loading, for the status line ("Loading Releases…"). */
  label?: string;
}) {
  return (
    <div aria-busy="true">
      <LoadingStatus>Loading {label}…</LoadingStatus>
      <PageHeader title={title} subtitle={<SkeletonText width="min(28rem, 70vw)" />} />
      <Card className="gap-4 [--card-spacing:--spacing(5)]">
        <CardHeader>
          <CardTitle className="section-title">
            <SkeletonText width="9rem" />
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y text-sm">
          {['62%', '48%', '71%', '55%'].map((w) => (
            <div key={w} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <SkeletonText width={w} className="flex-1" />
              <SkeletonPill />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
