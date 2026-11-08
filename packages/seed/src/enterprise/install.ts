import {
  type AppContext,
  type BulkChunkOutcome,
  type CreateSpaceInput,
  getSpaceConfig,
  persistJob,
} from '@commerceworker/application';
import { type Principal, SCOPES, type Scope } from '@commerceworker/domain';
import type { BulkJob, BulkJobChunk } from '@commerceworker/ports';
import { logger } from '@commerceworker/telemetry';
import type { SeedDeps } from '../types';
import { BRAND, DEFAULT_LOCALE, ENTERPRISE_FALLBACKS, ENTERPRISE_LOCALES } from './brand';
import { ENTERPRISE_PHASES, type EnterprisePhase } from './phases';
import type { EnterpriseRun } from './run';

/** The bulk job action every phase of an install runs under. */
export const STARTER_INSTALL_ACTION = 'starter_install' as const;

/** What a starter install's jobs carry in `config`, for the consumer and for progress readers. */
export interface StarterInstallConfig extends Record<string, unknown> {
  readonly starter: 'enterprise';
  /** Shared by every phase's job: one install is several chained jobs. */
  readonly install: string;
  readonly phase: string;
  readonly title: string;
  /** 1-based position of this phase, and how many there are. */
  readonly step: number;
  readonly steps: number;
}

export interface EnterpriseInstallStarted {
  /** The install id every phase's job carries in `config.install`. */
  readonly install: string;
  /** The first phase's job; the rest are created as each one completes. */
  readonly jobId: string;
  readonly steps: number;
}

/**
 * Describes the starter for pickers (the admin dialog, the starters route and tool).
 */
export const ENTERPRISE_STARTER_INFO = {
  id: 'enterprise',
  title: `Enterprise demo (${BRAND.name})`,
  description:
    `A global professional-services firm, ${BRAND.name}: ${ENTERPRISE_LOCALES.length} locales ` +
    'with fallbacks and right-to-left Arabic, 21 content types built from components and blocks, ' +
    'services, industries, insights, case studies, press releases, events, people and offices, ' +
    'with teams, roles, approval workflows, releases, schedules, menus, redirects and audit ' +
    'history. Installs in the background in a few minutes.',
  background: true,
  locales: ENTERPRISE_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
} as const;

/**
 * The space input the enterprise starter needs: the caller's own locales plus every market the
 * brand writes for, with the brand's fallbacks for the locales the caller didn't configure. The
 * caller's default locale stays the default (the brand's English master is written under it).
 */
export function enterpriseSpaceInput(input: CreateSpaceInput): CreateSpaceInput {
  const locales = [
    ...new Set([input.defaultLocale, ...(input.locales ?? []), ...ENTERPRISE_LOCALES]),
  ];
  const fallbacks: Record<string, string | null> = {};
  for (const [locale, to] of Object.entries(ENTERPRISE_FALLBACKS)) {
    if (locale === input.defaultLocale) continue;
    // A fallback onto the brand's English when English isn't the default reads the default.
    fallbacks[locale] = to === DEFAULT_LOCALE ? input.defaultLocale : to;
  }
  for (const [locale, to] of Object.entries(input.fallbacks ?? {})) fallbacks[locale] = to;
  if (input.defaultLocale !== DEFAULT_LOCALE && !(DEFAULT_LOCALE in fallbacks)) {
    fallbacks[DEFAULT_LOCALE] = input.defaultLocale;
  }
  return { ...input, locales, fallbacks };
}

const CHUNK_ID = 'c00000';

/**
 * Starts the enterprise install into one environment as a chain of jobs, one per phase. A phase is
 * one chunk sized to fit one consumer invocation's D1 budget (measured per phase in
 * packages/store/test/enterprise-starter.test.ts); the next phase's job is created in the same write
 * that finalizes the last, and only after a clean run, so the phases run in order and a phase that
 * fails for good stops the chain with its report naming why.
 *
 * Every phase is idempotent: it finds what an earlier run made and adds only what's missing. A
 * retried chunk, or starting the install again after a failure, finishes the job without
 * duplicating anything.
 */
export async function startEnterpriseInstall(
  ctx: AppContext,
  scope: Scope,
): Promise<EnterpriseInstallStarted> {
  const install = ctx.ids.newId();
  const steps = ENTERPRISE_PHASES.length;
  const actor = ctx.actor !== undefined ? { actor: ctx.actor } : {};
  const configOf = (phase: EnterprisePhase, i: number): StarterInstallConfig => ({
    starter: 'enterprise',
    install,
    phase: phase.id,
    title: phase.title,
    step: i + 1,
    steps,
    ...actor,
  });

  // Built from the last phase back, each job's config naming the one after it.
  let next: Record<string, unknown> | undefined;
  for (let i = steps - 1; i >= 1; i--) {
    const phase = ENTERPRISE_PHASES[i] as EnterprisePhase;
    next = {
      id: ctx.ids.newId(),
      totalItems: 1,
      chunkIds: [CHUNK_ID],
      config: { ...configOf(phase, i), ...(next ? { next } : {}) },
    };
  }

  const first = ENTERPRISE_PHASES[0] as EnterprisePhase;
  const jobId = ctx.ids.newId();
  const now = ctx.clock.now().toISOString();
  const job: BulkJob = {
    id: jobId,
    action: STARTER_INSTALL_ACTION,
    status: 'running',
    totalItems: 1,
    totalChunks: 1,
    completedChunks: 0,
    succeeded: 0,
    failed: 0,
    createdAt: now,
    config: { ...configOf(first, 0), ...(next ? { next } : {}) },
  };
  const chunk: BulkJobChunk = {
    jobId,
    chunkId: CHUNK_ID,
    entryIds: [],
    status: 'pending',
    attempts: 0,
    failures: [],
  };
  await persistJob(ctx, scope, job, [chunk], now);
  logger.info({ space: scope.spaceId, install, steps }, 'starter: enterprise install started');
  return { install, jobId, steps };
}

/**
 * The service principal the phases act as. The install was authorized when it started (creating a
 * space takes `space:admin` across the deployment), and its chunks run in the engine with no one
 * behind them, as every bulk job's do; the few use-cases that take a principal (locale settings,
 * shared saved views, workflow runs) get this one.
 */
export function installPrincipal(scope: Scope): Principal {
  return { spaceId: scope.spaceId, kind: 'admin', scopes: Object.values(SCOPES) };
}

async function enterpriseRun(
  ctx: AppContext,
  scope: Scope,
  deps: SeedDeps,
): Promise<EnterpriseRun> {
  const config = await getSpaceConfig(ctx, scope);
  return {
    ctx,
    scope,
    locale: config.defaultLocale,
    locales: config.locales,
    hasDe: config.locales.includes('de-DE'),
    scale: 1,
    space: { defaultLocale: config.defaultLocale, locales: config.locales },
    principal: installPrincipal(scope),
    ...(deps.blob ? { blob: deps.blob } : {}),
  };
}

/** Runs one phase by id. Unknown phases (a job from a newer or older release) are a failure. */
export async function runEnterprisePhase(
  ctx: AppContext,
  scope: Scope,
  phaseId: string,
  deps: SeedDeps = {},
): Promise<void> {
  const phase = ENTERPRISE_PHASES.find((p) => p.id === phaseId);
  if (!phase) throw new Error(`Unknown enterprise starter phase "${phaseId}"`);
  const run = await enterpriseRun(ctx, scope, deps);
  await phase.run(run);
  logger.info({ space: scope.spaceId, phase: phaseId }, 'starter: enterprise phase done');
}

/**
 * The chunk handler for `starter_install` jobs, injected into the bulk consumer by the engine
 * (the application layer can't import the seed). A throw releases the chunk for a retry; after
 * the bulk machinery's attempt limit the chunk fails for good and the chain stops.
 */
export function starterChunkRunner(
  ctx: AppContext,
  deps: SeedDeps = {},
): (scope: Scope, job: BulkJob, chunk: BulkJobChunk) => Promise<BulkChunkOutcome> {
  return async (scope, job) => {
    const phase = typeof job.config?.phase === 'string' ? job.config.phase : '';
    await runEnterprisePhase(ctx, scope, phase, deps);
    return { succeeded: 1, failures: [] };
  };
}

/**
 * Installs everything in one go, in process: local dev (where a request has no D1 call limit) and
 * tests. Deployments use {@link startEnterpriseInstall}.
 */
export async function installEnterpriseNow(
  ctx: AppContext,
  scope: Scope,
  deps: SeedDeps = {},
): Promise<void> {
  for (const phase of ENTERPRISE_PHASES) await runEnterprisePhase(ctx, scope, phase.id, deps);
}
