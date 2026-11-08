import { seedEnterpriseAssets } from './assets';
import { seedEnterpriseBlocks } from './blocks';
import { seedEnterpriseGovernance, seedEnterpriseWorkflows } from './governance';
import { INSIGHT_COUNT, seedEnterpriseInsights, seedEnterpriseSeries } from './insights';
import { seedEnterpriseBulletins, seedEnterpriseEvents } from './media';
import { seedEnterpriseModel } from './model';
import { seedEnterpriseOfferings } from './offerings';
import {
  seedEnterpriseCollaboration,
  seedEnterpriseHistory,
  seedEnterpriseIntegrations,
  seedEnterpriseNavigation,
  seedEnterprisePublishing,
} from './operations';
import { PEOPLE, seedEnterpriseOffices, seedEnterprisePeople } from './people';
import type { EnterpriseRun } from './run';
import { seedEnterpriseSite } from './site';
import { seedEnterpriseCaseStudies, seedEnterpriseNewsroom } from './stories';
import { seedEnterpriseTaxonomy } from './taxonomy';

/** One step of the enterprise install: idempotent, and sized to one consumer invocation. */
export interface EnterprisePhase {
  readonly id: string;
  readonly title: string;
  readonly run: (run: EnterpriseRun) => Promise<void>;
}

/** Insights per phase: what fits one invocation's D1 budget with room to spare. */
const INSIGHTS_PER_PHASE = 14;
/** People per phase: the first phase also writes the corporate bylines. */
const PEOPLE_SPLIT = 22;

const insightPhases: EnterprisePhase[] = [];
for (let from = 0; from < INSIGHT_COUNT; from += INSIGHTS_PER_PHASE) {
  const to = Math.min(from + INSIGHTS_PER_PHASE, INSIGHT_COUNT);
  insightPhases.push({
    id: `insights-${insightPhases.length + 1}`,
    title: `Insights ${from + 1}–${to}`,
    run: (r) => seedEnterpriseInsights(r, from, to),
  });
}

/**
 * In order: each phase looks up by key what the phases before it made (an office before the
 * people in it, people before what they author, content before the releases, menus and
 * workflows that point at it). Sizes are measured in packages/store/test/enterprise-starter.test.ts.
 */
export const ENTERPRISE_PHASES: readonly EnterprisePhase[] = [
  { id: 'settings', title: 'Locales, environments, roles and team', run: seedEnterpriseGovernance },
  { id: 'model', title: 'Content model', run: seedEnterpriseModel },
  { id: 'taxonomy', title: 'Taxonomy', run: seedEnterpriseTaxonomy },
  { id: 'assets', title: 'Media library', run: seedEnterpriseAssets },
  { id: 'offices', title: 'Offices', run: seedEnterpriseOffices },
  {
    id: 'people-1',
    title: 'People: leadership and the Americas',
    run: (r) => seedEnterprisePeople(r, 0, PEOPLE_SPLIT),
  },
  {
    id: 'people-2',
    title: 'People: EMEIA and Asia-Pacific',
    run: (r) => seedEnterprisePeople(r, PEOPLE_SPLIT, PEOPLE.length),
  },
  { id: 'blocks', title: 'Disclaimers, forms, CTAs, legal and careers', run: seedEnterpriseBlocks },
  { id: 'services', title: 'Services', run: (r) => seedEnterpriseOfferings(r, 'services') },
  {
    id: 'industries',
    title: 'Industries and alliances',
    run: (r) => seedEnterpriseOfferings(r, 'industries'),
  },
  { id: 'series', title: 'Series', run: seedEnterpriseSeries },
  ...insightPhases,
  { id: 'case-studies', title: 'Case studies', run: seedEnterpriseCaseStudies },
  { id: 'newsroom', title: 'Newsroom', run: seedEnterpriseNewsroom },
  { id: 'events', title: 'Events and podcasts', run: seedEnterpriseEvents },
  { id: 'bulletins', title: 'Technical bulletins', run: seedEnterpriseBulletins },
  { id: 'site', title: 'Home, pages and site settings', run: seedEnterpriseSite },
  { id: 'workflows', title: 'Workflows and approvals', run: seedEnterpriseWorkflows },
  { id: 'collaboration', title: 'Comments, tasks and agents', run: seedEnterpriseCollaboration },
  { id: 'publishing', title: 'Releases and schedules', run: seedEnterprisePublishing },
  {
    id: 'integrations',
    title: 'Webhooks, functions, extensions and AI actions',
    run: seedEnterpriseIntegrations,
  },
  { id: 'navigation', title: 'Menus, redirects and saved views', run: seedEnterpriseNavigation },
  { id: 'history', title: 'Audit history', run: seedEnterpriseHistory },
];
