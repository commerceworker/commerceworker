/**
 * A node type's icon and its category accent. The icon set is the editorial catalog's
 * (packages/domain/src/workflow/nodes.ts).
 */

import type { NodeCategory } from '@commerceworker/domain';
import {
  Bell,
  CalendarClock,
  CircleStop,
  ClipboardList,
  EyeOff,
  FilePlus2,
  Flag,
  Gauge,
  Globe,
  Hourglass,
  IterationCw,
  Languages,
  LayersPlus,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  NotebookPen,
  Package,
  PackageCheck,
  PackagePlus,
  PenLine,
  Play,
  Puzzle,
  RotateCw,
  Save,
  Scale,
  Send,
  Shapes,
  ShieldAlert,
  Signpost,
  Split,
  Tag,
  Tags,
  TextCursorInput,
  Timer,
  Upload,
  UserCheck,
  Variable,
  Webhook,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  Bell,
  CalendarClock,
  CircleStop,
  ClipboardList,
  EyeOff,
  FilePlus2,
  Flag,
  Gauge,
  Globe,
  Hourglass,
  IterationCw,
  Languages,
  ListChecks,
  MessageSquare,
  NotebookPen,
  Package,
  PackageCheck,
  PackagePlus,
  PenLine,
  Play,
  RotateCw,
  Save,
  Scale,
  Send,
  Shapes,
  ShieldAlert,
  Split,
  Tag,
  Tags,
  Timer,
  Upload,
  UserCheck,
  Variable,
  Webhook,
  LayersPlus,
  Signpost,
  TextCursorInput,
};

export function NodeIcon({
  name,
  className,
  style,
}: {
  name: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  // An icon this set doesn't have shows as a puzzle piece.
  const Icon = ICONS[name] ?? Puzzle;
  return <Icon className={className} style={style} aria-hidden="true" />;
}

/** Category accent, as a CSS color (tokens in index.css). */
export const CATEGORY_COLOR: Record<NodeCategory, string> = {
  trigger: 'var(--cat-trigger)',
  content: 'var(--color-cat-content)',
  control: 'var(--cat-control)',
  ai: 'var(--cat-ai)',
};

/** A category's name in the singular, for a node card's icon. */
export const CATEGORY_NAME: Record<NodeCategory, string> = {
  trigger: 'Trigger',
  content: 'Content',
  control: 'Control',
  ai: 'AI',
};
