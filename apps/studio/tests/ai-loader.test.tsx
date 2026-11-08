// The AI loader: CommerceWorker's mark composing itself while a model works. Its marks run the
// `cw-compose` keyframes in reading order, it stays out of the accessibility tree unless it is the
// status itself, a sequence moves to its next icon once the current one is cleared, and where
// motion is reduced it is drawn whole and holds still.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aiMark,
  ComposeLoader,
  composeIcons,
  composeSequences,
} from '@commerceworker/ui/compose-loader';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const css = readFileSync(join(process.cwd(), 'app/app.css'), 'utf8');
const marks = (el: Element) => Array.from(el.querySelectorAll('[data-mark]'));

describe('ComposeLoader', () => {
  afterEach(() => vi.useRealTimers());

  it('draws the mark by default, its marks offset in reading order', () => {
    const { container } = render(<ComposeLoader />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.classList.contains('cw-compose')).toBe(true);
    const delays = marks(container).map((m) => (m as SVGElement).style.animationDelay);
    expect(delays).toEqual(aiMark.map((m) => `${m.at}ms`));
  });

  it('is the status itself only when labelled', () => {
    render(<ComposeLoader label="Generating a draft" />);
    expect(screen.getByRole('status', { name: 'Generating a draft' })).toBeTruthy();
  });

  it('draws the icon whole and still when not playing', () => {
    const { container } = render(<ComposeLoader playing={false} />);
    expect(container.querySelector('svg')?.classList.contains('cw-compose')).toBe(false);
    expect(marks(container)).toHaveLength(aiMark.length);
  });

  it('plays a sequence one icon per cycle, opening on the mark', () => {
    vi.useFakeTimers();
    const { container } = render(<ComposeLoader icon={composeSequences.drafting} />);
    expect(marks(container)).toHaveLength(aiMark.length);
    act(() => vi.advanceTimersByTime(2464));
    expect(marks(container)).toHaveLength(composeIcons.write.length);
    act(() => vi.advanceTimersByTime(2464));
    expect(marks(container)).toHaveLength(composeIcons.schema.length);
  });

  it('draws every mark before the icon starts to fade, so each one is seen whole', () => {
    for (const [name, icon] of Object.entries(composeIcons)) {
      const last = Math.max(...icon.map((m) => m.at));
      // A mark is drawn 22% into its run; the icon starts fading at 72% of the 2.8s cycle.
      expect(last + 2800 * 0.22, name).toBeLessThanOrEqual(2800 * 0.6);
    }
  });

  it('runs on the stylesheet, and holds still where motion is reduced', () => {
    expect(css).toContain('@keyframes cw-compose-stroke');
    expect(css).toContain('@keyframes cw-compose-block');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.cw-compose > g,\s*\.cw-compose \[data-mark\] \{\s*animation: none;/,
    );
  });
});
