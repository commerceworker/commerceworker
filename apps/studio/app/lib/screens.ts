/**
 * The CMS's screens, in navigation order: where each lives and what it holds. The shell's
 * navigation reads this; the screens themselves are in app/cms (routes.ts maps them).
 */

export type Screen = {
  /** The route id in routes.ts. */
  id: string;
  /** Where the navigation links to. */
  to: string;
  label: string;
  /** What the screen does, in a sentence. */
  summary: string;
};

export const SCREENS = {
  content: {
    id: 'content',
    to: '/content',
    label: 'Content',
    summary: 'Entries by content type: browse, filter, and open one to edit.',
  },
  'content-type': {
    id: 'content-type',
    to: '/content',
    label: 'Content',
    summary: 'The entries of one content type, with their status and the columns it shows.',
  },
  'content-entry': {
    id: 'content-entry',
    to: '/content',
    label: 'Content',
    summary: 'The entry editor: fields, references, versions, comments and publishing.',
  },
  approvals: {
    id: 'approvals',
    to: '/approvals',
    label: 'Approvals',
    summary: 'Workflow steps waiting on your decision, oldest first.',
  },
  releases: {
    id: 'releases',
    to: '/releases',
    label: 'Releases',
    summary: 'Groups of changes published together, now or on a schedule.',
  },
  workflows: {
    id: 'workflows',
    to: '/workflows',
    label: 'Workflows',
    summary: 'Editorial workflows: their definitions, versions and runs.',
  },
  workflow: {
    id: 'workflow',
    to: '/workflows',
    label: 'Workflows',
    summary: 'One workflow: its steps, its versions and its recent runs.',
  },
  taxonomy: {
    id: 'taxonomy',
    to: '/taxonomy',
    label: 'Taxonomy',
    summary: 'Concept schemes, concepts and tags to classify entries.',
  },
  assets: {
    id: 'assets',
    to: '/assets',
    label: 'Assets',
    summary: 'Assets: upload, describe, find and publish images, video and files.',
  },
  settings: {
    id: 'settings',
    to: '/settings/team',
    label: 'Settings',
    summary:
      'Spaces, environments, content types, locales, roles, API keys, webhooks, redirects, menus and extensions.',
  },
} as const satisfies Record<string, Screen>;

export type ScreenId = keyof typeof SCREENS;

export const isScreenId = (v: unknown): v is ScreenId =>
  typeof v === 'string' && Object.hasOwn(SCREENS, v);
