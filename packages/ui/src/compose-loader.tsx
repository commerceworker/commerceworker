import * as React from 'react';
import { cn } from './lib/utils';

/*
 * Ledger's AI loader: a model at work, drawn as content being composed. An icon is a list of
 * marks in a 24-unit box (strokes, and filled blocks), and each mark writes itself in reading
 * order (a stroke draws along its path, a block is revealed from its leading edge), holds, then is
 * taken away in the same order while the icon fades, the way a line of type is set and cleared. Nothing falls,
 * spins or sparkles: the default icon is the page mark (frame, title block,
 * two lines of body), so the thing the agent is making is the loader itself.
 *
 * The look and timing are `.cw-compose` in the admin's app.css: one 2.8s cycle, each mark offset
 * by its own `at`. A sequence plays one icon per cycle. Where motion is reduced, the icon is drawn
 * whole and holds still, and a sequence holds on its first icon. The loader is decoration
 * (`aria-hidden`); the line beside it says what is happening, unless `label` makes it the status.
 */

/** One mark: a stroked path, or a filled block revealed from its left edge. */
export type ComposeMark =
  | { kind: 'stroke'; d: string; at: number; width?: number }
  | { kind: 'block'; x: number; y: number; w: number; h: number; at: number; r?: number };

export type ComposeIcon = readonly ComposeMark[];

/** One cycle, in ms (keep in step with `--compose-cycle` in app.css). */
const CYCLE = 2800;
/** The share of a cycle the icon is on screen: it has faded out by 88% (`cw-compose-out`). */
const SHOWN = 0.88;

const stroke = (d: string, at: number, width?: number): ComposeMark => ({
  kind: 'stroke',
  d,
  at,
  width,
});
const block = (x: number, y: number, w: number, h: number, at: number, r = 0.75): ComposeMark => ({
  kind: 'block',
  x,
  y,
  w,
  h,
  at,
  r,
});

/** A rounded frame, drawn clockwise from its top-left corner. */
const frame = (x: number, y: number, w: number, h: number, r = 3) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1-${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1-${r}-${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r}-${r}`;

/** The page mark composing itself: the default until CommerceWorker's own mark lands (ROADMAP P9). */
export const aiMark: ComposeIcon = [
  stroke(frame(3.5, 3.5, 17, 17), 0),
  block(7.5, 7.5, 9, 3, 220),
  stroke('M7.5 14h9', 320),
  stroke('M7.5 17h5', 400),
];

/** Writing: a heading over a ragged paragraph (generating or rewriting text). */
export const write: ComposeIcon = [
  block(3.5, 3.5, 11, 3, 0),
  stroke('M3.5 10.5h17', 110),
  stroke('M3.5 14.5h14', 200),
  stroke('M3.5 18.5h9', 290),
];

/** A content type: three fields, each a label and its value (modeling, filling fields). */
export const schema: ComposeIcon = [
  block(3.5, 4, 4, 3, 0),
  stroke('M11 5.5h9.5', 70),
  block(3.5, 10.5, 4, 3, 150),
  stroke('M11 12h7', 220),
  block(3.5, 17, 4, 3, 300),
  stroke('M11 18.5h9', 370),
];

/** An asset: a frame, the sun, the land (alt text, tagging, image work). */
export const asset: ComposeIcon = [
  stroke(frame(3.5, 3.5, 17, 17), 0),
  stroke('M10 8.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0', 230),
  stroke('M7.5 20.5l8-8 5 5', 320),
];

/** Search: a lens and its handle (semantic search, finding related content). */
export const search: ComposeIcon = [
  stroke('M10.5 3.5a7 7 0 1 1 0 14a7 7 0 1 1 0-14', 0),
  stroke('M15.5 15.5l5 5', 300),
];

/**
 * A workflow: one step leading to the next (an agent running a workflow). The steps sit on whole
 * units, so their edges land on the pixel grid and stay sharp at icon size.
 */
export const workflow: ComposeIcon = [
  block(3, 3, 6, 6, 0, 1.5),
  stroke('M6 9v6a3 3 0 0 0 3 3h6', 140),
  block(15, 15, 6, 6, 360, 1.5),
];

/** Every icon by name, for pickers and the docs. */
export const composeIcons = { aiMark, write, schema, asset, search, workflow } as const;

/** Sequences: one icon per cycle. Each opens on the mark, so a short wait still shows it. */
export const composeSequences = {
  /** Generating an entry: the page, its text, its fields. */
  drafting: [aiMark, write, schema],
  /** Enriching assets and content: the page, the image, the search for what's related. */
  enriching: [aiMark, asset, search],
  /** An agent at work across the space. */
  working: [aiMark, write, schema, asset, search, workflow],
} as const satisfies Record<string, readonly ComposeIcon[]>;

/** The ms after an icon starts until it has faded out, when a sequence moves on. */
const SHOWN_FOR = CYCLE * SHOWN;

function isSequence(icon: ComposeIcon | readonly ComposeIcon[]): icon is readonly ComposeIcon[] {
  return Array.isArray(icon[0]);
}

export type ComposeLoaderProps = Omit<React.ComponentProps<'svg'>, 'children'> & {
  /** An icon, which loops, or a sequence, which plays one icon per cycle. Default `aiMark`. */
  icon?: ComposeIcon | readonly ComposeIcon[];
  /** False draws the icon whole and still: the same mark, at rest. */
  playing?: boolean;
  /** Makes the loader the status itself (`role="status"`), for when no text sits beside it. */
  label?: string;
};

/**
 * The AI loader. Sized and coloured like an icon: `size-4` and `currentColor` unless the caller
 * says otherwise; a model's work takes the `ai` tone (`text-ai`).
 */
function ComposeLoader({
  icon = aiMark,
  playing = true,
  label,
  className,
  ...props
}: ComposeLoaderProps) {
  const sequence: readonly ComposeIcon[] = isSequence(icon) ? icon : [icon];
  const [tick, setTick] = React.useState(0);

  // A new sequence starts from its first icon.
  const [lastIcon, setLastIcon] = React.useState(icon);
  if (lastIcon !== icon) {
    setLastIcon(icon);
    setTick(0);
  }

  const current = sequence[tick % sequence.length] ?? aiMark;
  const cycling = playing && sequence.length > 1;

  // A sequence moves on once the current icon has been cleared. Where motion is reduced the marks
  // don't play, so it holds on the first icon (nothing travels).
  React.useEffect(() => {
    if (!cycling || prefersReducedMotion()) return;
    const id = setTimeout(() => setTick((t) => t + 1), SHOWN_FOR);
    return () => clearTimeout(id);
  }, [cycling, current]);

  const svg = (
    <svg
      data-slot="compose-loader"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-4 shrink-0', playing && 'cw-compose', className)}
      aria-hidden="true"
      {...props}
    >
      {/* Keyed by icon, so the next icon in a sequence starts its marks from the top. */}
      <g key={tick}>
        {current.map((mark, i) => {
          const style = { animationDelay: `${mark.at}ms` };
          return mark.kind === 'stroke' ? (
            <path
              key={i}
              d={mark.d}
              pathLength={1}
              strokeWidth={mark.width}
              data-mark="stroke"
              style={style}
            />
          ) : (
            <rect
              key={i}
              x={mark.x}
              y={mark.y}
              width={mark.w}
              height={mark.h}
              rx={mark.r}
              fill="currentColor"
              stroke="none"
              data-mark="block"
              style={style}
            />
          );
        })}
      </g>
    </svg>
  );
  return label ? (
    <span role="status" aria-label={label} className="inline-flex">
      {svg}
    </span>
  ) : (
    svg
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
  );
}

export { ComposeLoader };
