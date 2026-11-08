import { cn } from './lib/utils';

/*
 * Ledger skeletons: the shape of data that hasn't arrived, drawn where it will land. Everything
 * already known (titles, headers, labels) is drawn for real around them; a skeleton stands in only
 * for the data. They are decoration: hidden from assistive technology, so the region announces its
 * load once (a `role="status"` line) instead. The look and timing are `.cw-skeleton` in the admin's
 * app.css: a 200ms grace before it fades in (a quick answer never flashes one), then a slow breath
 * between two greys, held still where motion is reduced.
 */

/** A block: a thumbnail, a tile, a field. The tile radius unless the caller rounds it. */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('cw-skeleton rounded-xl', className)}
      {...props}
    />
  );
}

/** Ragged line lengths, so a paragraph of skeleton reads as text, not as a bar chart. */
const RAGGED = ['92%', '78%', '85%', '64%', '88%', '71%'];

/**
 * Lines of text in the surrounding type: each line is one line-height tall (so swapping in the
 * real text moves nothing), with a pill-round bar about cap-height thick inside it. Set the size on
 * the parent (`text-sm`, `section-title`) as the real text would be. `width` sets a single line's
 * length; several lines take ragged lengths, the last the shortest.
 */
function SkeletonText({
  lines = 1,
  width,
  className,
  ...props
}: React.ComponentProps<'span'> & { lines?: number; width?: string }) {
  return (
    <span
      data-slot="skeleton-text"
      aria-hidden="true"
      className={cn('flex w-full flex-col', className)}
      {...props}
    >
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="flex h-[1lh] items-center">
          <span
            data-slot="skeleton"
            className="cw-skeleton block h-[0.7em] max-w-full rounded-full"
            style={{
              width:
                lines === 1
                  ? (width ?? '60%')
                  : i === lines - 1
                    ? '48%'
                    : (RAGGED[i % RAGGED.length] ?? '80%'),
            }}
          />
        </span>
      ))}
    </span>
  );
}

/**
 * Anything you press or that labels a status is a pill (The Pill Rule), and so is its skeleton:
 * a badge by default (h-5), a small button with `className="h-8 w-20"`.
 */
function SkeletonPill({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        'cw-skeleton inline-block h-5 w-16 shrink-0 rounded-full align-middle',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton, SkeletonPill, SkeletonText };
