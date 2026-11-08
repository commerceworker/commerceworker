import { cn } from './lib/utils';

export interface DotGridProps {
  /** Extra classes. A `[mask-image:…]` here replaces the default corner fade. */
  className?: string;
}

/**
 * Measured dot grid for chrome surfaces.
 *
 * This system reads as an instrument face, so the backdrop is graph paper
 * rather than a wash. It replaced a full-viewport radial glow that sat at
 * 6–9% opacity: too faint to see, and the wrong grammar if it were turned up.
 *
 * The single opacity is deliberate. Foreground against the sunken step is a
 * lightness delta of ~0.11 in dark and ~0.107 in light at this value, so the
 * texture lands with the same weight in both themes instead of needing a
 * per-theme override that drifts.
 *
 * Anchored top-left and faded out diagonally by default, so it reads as a
 * corner texture rather than wallpaper and never competes with content sitting
 * on top. Pass a `[mask-image:…]` to override the fade.
 *
 * Decorative: always `aria-hidden`, never the only carrier of meaning.
 */
export function DotGrid({ className }: DotGridProps) {
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0',
        'bg-[radial-gradient(var(--foreground)_1px,transparent_1px)] bg-[length:18px_18px]',
        'opacity-[0.14]',
        '[mask-image:radial-gradient(120%_100%_at_0%_0%,black,transparent_72%)]',
        className,
      )}
    />
  );
}
