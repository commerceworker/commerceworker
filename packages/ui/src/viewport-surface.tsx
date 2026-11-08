import type { ReactNode } from 'react';
import { DotGrid } from './dot-grid';
import { cn } from './lib/utils';

/**
 * Full-viewport chrome surface for authenticated app layouts (sidebar shells),
 * matching the sign-in brand panel so the product does not change texture the
 * moment you log in.
 *
 * This carried a radial glow from `--primary` at 6–9% opacity. Measured against
 * the page it was imperceptible — screenshots with and without were
 * indistinguishable — and turning it up would have made it the gradient hero
 * DESIGN.md rules out. The dot grid is the same idea done as texture: visible,
 * on-brief for an instrument face, and it reads only in the gutters because
 * content sits on opaque `bg-card` panels above it.
 */
export function ViewportSurface({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('relative min-h-svh w-full bg-background', className)}>
      {/* Same texture and weight as the sign-in brand panel, anchored in the
          same top-left corner: the product should not change surface the moment
          you log in. Fixed, so it holds still while content scrolls over it. */}
      <DotGrid className="fixed" />

      {children}
    </div>
  );
}
