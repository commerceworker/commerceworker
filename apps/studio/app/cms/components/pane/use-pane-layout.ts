import { useLayoutEffect, useState } from 'react';

/**
 * The widths the entry form and the side pane each need before they can sit side by side: a form
 * column, and the panels' own 21rem. Below their sum the pane stacks under the form instead of
 * squeezing either one. Measured on the row they share, not on the viewport, so collapsing the
 * sidebar buys the split back. (After felix's side pane.)
 */
export const MAIN_MIN_PX = 420;
export const PANE_MIN_PX = 336;

const SHARE_KEY = 'cw.entry-pane.share';
/** Under half: the form keeps the larger side until someone moves the divider. */
export const DEFAULT_SHARE = 0.4;

function readShare(): number {
  try {
    const v = Number(localStorage.getItem(SHARE_KEY));
    return Number.isFinite(v) && v > 0 && v < 1 ? v : DEFAULT_SHARE;
  } catch {
    return DEFAULT_SHARE;
  }
}

function writeShare(v: number) {
  try {
    if (v === DEFAULT_SHARE) localStorage.removeItem(SHARE_KEY);
    else localStorage.setItem(SHARE_KEY, v.toFixed(3));
  } catch {
    // Storage blocked: the split lasts for this page.
  }
}

export interface PaneLayout {
  /** The row the form and the pane share: a callback ref, so a row that mounts late is measured. */
  ref: (el: HTMLElement | null) => void;
  /** Room for both side by side. */
  split: boolean;
  /** The pane's share of the row, clamped so neither side drops below its floor. */
  share: number;
  min: number;
  max: number;
  onChange: (share: number) => void;
  onCommit: (share: number) => void;
  onReset: () => void;
}

/**
 * Where the divider stands. The share is per browser rather than per entry (it is how this screen
 * likes to be divided), and a drag is held apart from it, so a drag writes to storage once, when
 * it ends. The server can't measure, so it draws the stacked layout and the split arrives before
 * the first paint after hydration.
 */
export function usePaneLayout(): PaneLayout {
  const [el, ref] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  const [stored, setStored] = useState(DEFAULT_SHARE);
  useLayoutEffect(() => setStored(readShare()), []);
  const [live, setLive] = useState<number | null>(null);

  const split = width >= MAIN_MIN_PX + PANE_MIN_PX;
  const min = width ? Math.min(PANE_MIN_PX / width, 0.5) : DEFAULT_SHARE;
  const max = width ? Math.max(1 - MAIN_MIN_PX / width, min) : DEFAULT_SHARE;
  const share = Math.min(max, Math.max(min, live ?? stored));

  return {
    ref,
    split,
    share,
    min,
    max,
    onChange: setLive,
    onCommit: (v) => {
      setLive(null);
      setStored(v);
      writeShare(v);
    },
    onReset: () => {
      setLive(null);
      setStored(DEFAULT_SHARE);
      writeShare(DEFAULT_SHARE);
    },
  };
}

/**
 * What the entry editor's side pane shows: the draft as a document, the entry's panels, or its
 * activity (the audit rows about it, for a space administrator).
 */
export type PaneView = 'preview' | 'details' | 'activity';

const VIEW_KEY = 'cw.entry-pane.view';

/** The pane's view, remembered per browser; Details until someone picks another. */
export function usePaneView(): [PaneView, (v: PaneView) => void] {
  const [view, setView] = useState<PaneView>('details');
  useLayoutEffect(() => {
    try {
      const kept = localStorage.getItem(VIEW_KEY);
      if (kept === 'preview' || kept === 'activity') setView(kept);
    } catch {
      // Storage blocked: Details.
    }
  }, []);
  return [
    view,
    (v) => {
      setView(v);
      try {
        if (v === 'details') localStorage.removeItem(VIEW_KEY);
        else localStorage.setItem(VIEW_KEY, v);
      } catch {
        // Storage blocked: the choice lasts for this page.
      }
    },
  ];
}
