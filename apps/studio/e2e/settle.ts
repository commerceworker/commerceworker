import type { Page } from '@playwright/test';

/**
 * Waits until nothing on the page is mid-transition, so axe reads the colours a person sees at
 * rest rather than a frame of a fade (a sampled intermediate colour or opacity can fall under
 * 4.5:1 between two values that both pass). Endless animations (a live pulse, the slow-page
 * sweep, a shimmer) never settle and are left alone; everything else must finish first.
 *
 * Not a substitute for fixing a control that is genuinely low-contrast while enabled: see
 * contrast-settle.spec.ts for the case that made this necessary.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) =>
          a.playState !== 'running' ||
          a.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
      ),
  );
}
