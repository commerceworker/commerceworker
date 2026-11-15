import { useEffect } from 'react';
import { useMediaQuery } from './shortcuts';

/*
 * Device helpers. `useShortcutLabel` lives in
 * lib/shortcuts.ts with the rest of the keyboard layer.
 */

/**
 * Whether a media query matches, following changes live. False where `matchMedia` is missing
 * (tests), so pick the query so that false is the safe answer ("wide enough to edit?").
 */
export const useMedia = useMediaQuery;

/** Below Tailwind's `sm`: an iPhone upright, where a form sheet comes from the bottom. */
export const PHONE = '(max-width: 639px)';

/** Tailwind's `lg`: the width the assistant column and the entry editor's side panels need. */
export const WIDE = '(min-width: 1024px)';

/** A finger rather than a mouse or trackpad, checked when it matters (an Enter key, say). */
export const coarse = () => !!window.matchMedia?.('(pointer: coarse)').matches;

/**
 * While mounted, mirrors the visual viewport (what's left above the on-screen keyboard) into CSS:
 * `--vvh` and `--vvtop` on <html>, and `data-keyboard` while the keyboard is up, so a fixed panel
 * (the assistant sheet) can pin itself to the visible area. iPadOS doesn't resize the page for its
 * keyboard, so "up" means the visible height is under 80% of the tallest seen at this width.
 */
export function useVisualViewport(active = true) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const root = document.documentElement;
    let width = 0;
    let tallest = 0;
    const update = () => {
      if (vv.width !== width) {
        width = vv.width;
        tallest = 0;
      }
      tallest = Math.max(tallest, vv.height);
      root.style.setProperty('--vvh', `${vv.height}px`);
      root.style.setProperty('--vvtop', `${vv.offsetTop}px`);
      root.toggleAttribute('data-keyboard', vv.height < tallest * 0.8);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.removeAttribute('data-keyboard');
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vvtop');
    };
  }, [active]);
}

/** Running from the Home Screen as its own app, not in a browser tab. */
export function isStandalone() {
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** An iPhone or iPad. iPadOS says it's a Mac; its touch points give it away. */
export const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
