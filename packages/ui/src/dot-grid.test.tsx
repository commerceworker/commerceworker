import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DotGrid } from './dot-grid';

afterEach(() => {
  // Vitest `globals` is off here, so RTL never registers its automatic cleanup.
  cleanup();
});

describe('DotGrid', () => {
  it('is decorative and never announced', () => {
    const { container } = render(<DotGrid />);
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.getAttribute('aria-hidden')).toBe('true');
    expect(grid.className).toContain('pointer-events-none');
  });

  it('draws from the foreground token rather than a fixed colour, so it tracks the theme', () => {
    const { container } = render(<DotGrid />);
    expect((container.firstElementChild as HTMLElement).className).toContain('var(--foreground)');
  });

  it('carries one opacity for both themes', () => {
    // A per-theme override is what drifts; the token delta already lands within
    // ~0.003 lightness of itself across light and dark at this value.
    const { container } = render(<DotGrid />);
    const cls = (container.firstElementChild as HTMLElement).className;
    expect(cls).toContain('opacity-[0.14]');
    expect(cls).not.toContain('dark:opacity');
  });

  it('fades from the top-left corner by default rather than tiling edge to edge', () => {
    const { container } = render(<DotGrid />);
    expect((container.firstElementChild as HTMLElement).className).toContain(
      'radial-gradient(120%_100%_at_0%_0%',
    );
  });

  it('lets a caller position it without losing the fade', () => {
    // The app shell pins it so it holds still while content scrolls over it.
    const { container } = render(<DotGrid className="fixed" />);
    const cls = (container.firstElementChild as HTMLElement).className;
    expect(cls).toContain('fixed');
    expect(cls).toContain('mask-image');
  });
});
