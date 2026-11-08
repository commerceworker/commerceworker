import { cn } from '@commerceworker/ui/lib/utils';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';

/**
 * The edge between the entry form and the side pane, which moves (after felix's side pane).
 *
 * A `separator` that takes focus is the ARIA splitter: its value is where it stands, here the
 * pane's share of the width; the arrow keys move it (Shift for a larger step), Home and End go to
 * either limit, and Enter (or a double click) puts it back where it starts. A drag captures the
 * pointer, so a fast drag across the form's text selects nothing and loses nothing.
 *
 * At rest it is the hairline every other edge is; on hover, focus or drag it thickens into a grip,
 * so it says it can move only when the pointer is there to move it.
 */
export function PaneDivider({
  share,
  min,
  max,
  onChange,
  onCommit,
  onReset,
  controls,
  label = 'Resize the side pane',
}: {
  /** The pane's share of the row, 0–1. */
  share: number;
  min: number;
  max: number;
  /** While moving: the share under the pointer, from the row's right edge. */
  onChange: (share: number) => void;
  /** When a move ends: the share to keep. */
  onCommit: (share: number) => void;
  onReset: () => void;
  /** The id of the pane it sizes. */
  controls: string;
  label?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const row = useRef<DOMRect | null>(null);
  const latest = useRef(share);
  latest.current = share;

  const fromPointer = (clientX: number) => {
    const r = row.current;
    if (!r || r.width === 0) return latest.current;
    return clamp((r.right - clientX) / r.width, min, max);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const parent = e.currentTarget.parentElement;
    if (!parent) return;
    e.preventDefault();
    row.current = parent.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) onChange(fromPointer(e.clientX));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit(fromPointer(e.clientX));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    let next: number | null = null;
    // Left widens the pane: the edge moves the way the key points.
    if (e.key === 'ArrowLeft') next = share + step;
    else if (e.key === 'ArrowRight') next = share - step;
    else if (e.key === 'Home') next = max;
    else if (e.key === 'End') next = min;
    else if (e.key === 'Enter') {
      e.preventDefault();
      onReset();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    onCommit(clamp(next, min, max));
  };

  const pct = Math.round(share * 100);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA splitter; <hr> can't take focus or a value.
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      aria-valuenow={pct}
      aria-valuetext={`Side pane ${pct}% of the width`}
      title="Drag to resize · double-click to reset"
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className="group/divider relative z-10 w-px shrink-0 cursor-col-resize touch-none select-none self-stretch bg-border outline-none"
    >
      {/* The hit area: 12px (24px on touch), centred on the hairline. */}
      <span
        aria-hidden
        className="absolute inset-y-0 -right-1.5 -left-1.5 touch:-right-3 touch:-left-3"
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 bg-ring/0 transition-[background-color] duration-150 ease-out motion-reduce:transition-none',
          'group-hover/divider:bg-foreground/25 group-focus-visible/divider:bg-ring group-data-[dragging]/divider:bg-foreground/40',
        )}
      />
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
