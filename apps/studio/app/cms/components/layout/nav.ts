import {
  Blocks,
  Building2,
  FileText,
  Image,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Rocket,
  Settings as SettingsIcon,
  Stamp,
  Tags,
  Workflow,
  Zap,
} from 'lucide-react';
import type { Features } from '../../lib/features';

/**
 * The one list of top-level destinations, in order: the day's work first (no group
 * label), then Build, then Library (reference pages), then Settings. The sidebar, the phone's tab
 * bar and More sheet, the command palette's "Go to" group, the breadcrumbs and the G-then-letter
 * shortcuts all read it, so they list the same pages in the same order with the same names.
 */
export interface NavItem {
  /** Route path, also the first URL segment's breadcrumb. */
  readonly to: string;
  /** Sentence-case name, used verbatim everywhere the page is named. */
  readonly label: string;
  readonly icon: LucideIcon;
  /** Press G, then this letter, to go here. Lowercase. */
  readonly shortcutKey: string;
  /** The sidebar group it belongs to; the day's work has none. */
  readonly section?: 'Build' | 'Library' | 'Settings';
  /** A phone tab (the day's work, in thumb reach); everything else is under More. */
  readonly tab?: boolean;
  /** Carries the pending count (the shell's one call for attention). */
  readonly badge?: boolean;
  /** Shown only while this feature is on (lib/features.tsx). */
  readonly feature?: keyof Features;
}

export const NAV: readonly NavItem[] = [
  { to: '/dashboard', label: 'Overview', icon: LayoutDashboard, shortcutKey: 'h', tab: true },
  { to: '/content', label: 'Content', icon: FileText, shortcutKey: 'c', tab: true },
  {
    to: '/approvals',
    label: 'Approvals',
    icon: Stamp,
    shortcutKey: 'a',
    tab: true,
    badge: true,
    feature: 'approvals',
  },
  { to: '/releases', label: 'Releases', icon: Rocket, shortcutKey: 'r', tab: true },
  { to: '/workflows', label: 'Workflows', icon: Workflow, shortcutKey: 'w', section: 'Build' },
  { to: '/assets', label: 'Assets', icon: Image, shortcutKey: 'm', section: 'Library' },
  { to: '/taxonomy', label: 'Taxonomy', icon: Tags, shortcutKey: 't', section: 'Library' },
  {
    to: '/settings',
    label: 'Settings',
    icon: SettingsIcon,
    shortcutKey: 's',
    section: 'Settings',
  },
];

/** NAV as this deployment shows it: items behind a feature that's off are left out. */
export function visibleNav(features: Features): readonly NavItem[] {
  return NAV.filter((n) => !n.feature || features[n.feature]);
}

/** A Settings section, addressed as `/settings/:id`. */
export interface SettingsSection {
  readonly id: string;
  readonly label: string;
}

export interface SettingsGroup {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly sections: readonly SettingsSection[];
}

/**
 * Settings' sections, grouped by what a person came to do. Order here is the order in the
 * sidebar's Settings group, the section nav, the mobile select, and the command palette.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    label: 'Access',
    icon: KeyRound,
    sections: [
      { id: 'team', label: 'Space access' },
      { id: 'api-keys', label: 'API keys' },
      { id: 'roles', label: 'Roles' },
      { id: 'connected-apps', label: 'Connected apps' },
    ],
  },
  {
    label: 'Automation',
    icon: Zap,
    sections: [
      { id: 'webhooks', label: 'Webhooks' },
      { id: 'functions', label: 'Functions' },
      { id: 'ai-actions', label: 'AI actions' },
    ],
  },
  {
    label: 'Extensions',
    icon: Blocks,
    sections: [
      { id: 'extensions', label: 'App extensions' },
      { id: 'plugins', label: 'Plugins' },
    ],
  },
  {
    label: 'Workspace',
    icon: Building2,
    sections: [
      { id: 'environments', label: 'Environments' },
      { id: 'locales', label: 'Locales' },
      { id: 'redirects', label: 'Redirects' },
      { id: 'menus', label: 'Menus' },
      { id: 'trash', label: 'Trash' },
      { id: 'audit-log', label: 'Audit log' },
    ],
  },
];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = SETTINGS_GROUPS.flatMap(
  (g) => g.sections,
);

export const DEFAULT_SETTINGS_SECTION = 'team';

/** The nav item whose route contains `pathname`, if any. */
export function navItemFor(pathname: string): NavItem | undefined {
  return NAV.find((n) => pathname === n.to || pathname.startsWith(`${n.to}/`));
}

/** True when `path` is `to` or under it (`end` for an exact match). */
export const isAt = (path: string, { to, end }: { to: string; end?: boolean }) =>
  end ? path === to : path === to || path.startsWith(`${to}/`);
