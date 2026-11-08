import {
  type AppContext,
  createHasher,
  createSpace,
  createTag,
  getSpaceConfig,
  listTags,
} from '@commerceworker/application';
import { type ApiKeyKind, scopesForKind } from '@commerceworker/domain';
import { logger } from '@commerceworker/telemetry';
import { seedAgents } from './agents';
import { seedAssets } from './assets';
import { seedAutomation } from './automation';
import { seedCollaboration } from './collaboration';
import { seedContentModel } from './content-model';
import { seedCorpus } from './corpus';
import { enterpriseSpaceInput, installEnterpriseNow } from './enterprise/install';
import { seedGovernance } from './governance';
import { seedReleases } from './releases';
import { seedTaxonomy } from './taxonomy';
import type { SeedConfig, SeedDeps, SeedRun } from './types';

export { volumes } from './corpus';
export {
  ENTERPRISE_STARTER_INFO,
  type EnterpriseInstallStarted,
  enterpriseSpaceInput,
  installEnterpriseNow,
  runEnterprisePhase,
  STARTER_INSTALL_ACTION,
  type StarterInstallConfig,
  startEnterpriseInstall,
  starterChunkRunner,
} from './enterprise/install';
export { ENTERPRISE_PHASES, type EnterprisePhase } from './enterprise/phases';
export {
  availableStarters,
  type CreatedSpace,
  type CreateSpaceWithStarterOptions,
  createSpaceWithStarter,
  installStarter,
  STARTER_VOLUMES,
  STARTERS,
  type Starter,
  type StarterInfo,
  type StarterSummary,
} from './starter';
export type { SeedConfig, SeedDeps } from './types';
export { seedConfigFrom } from './types';

/**
 * Bump when the dataset changes shape; the marker tag short-circuits every
 * subsequent boot to a single query and self-heals after a crashed partial
 * seed (it is created last).
 */
const MARKER_TAG = 'demo-seed-v3';

/** The local dev space the enterprise starter installs into, and its completion marker. */
export const ENTERPRISE_DEV_SPACE = 'aldermoor';
const ENTERPRISE_MARKER_TAG = 'enterprise-starter-v1';

/**
 * Idempotently bootstraps a fully-populated dev environment: the seed space,
 * dev API keys, and a demo dataset exercising every platform capability —
 * content model (all field types), a scaled entry corpus, assets, taxonomy,
 * releases, workflows, comments/tasks, webhooks/functions/extensions/AI
 * actions, scheduled actions, agent runs/reviews/schedules, roles, and audit.
 *
 * Safe to run on every boot from any composition root (Node API or edge
 * Worker): only `@commerceworker/application` use-cases and ports, no adapters, no
 * `node:` APIs, no randomness (index-derived data + the injected clock).
 */
export async function seedDev(
  ctx: AppContext,
  config: SeedConfig,
  deps: SeedDeps = {},
): Promise<void> {
  const scope = { spaceId: config.spaceId, environmentId: config.environmentId };
  const run: SeedRun = {
    ctx,
    scope,
    locale: config.defaultLocale,
    locales: config.locales,
    hasDe: config.locales.includes('de-DE'),
    scale: Math.max(1, Math.floor(config.scale ?? 1)),
  };

  // 1. Space + environment (skip if it already exists).
  if (!(await spaceExists(ctx, scope))) {
    await createSpace(ctx, {
      spaceId: config.spaceId,
      name: config.spaceId,
      defaultLocale: config.defaultLocale,
      locales: config.locales,
      environments: [config.environmentId],
    });
    logger.info({ space: config.spaceId }, 'seed: created space');
  }

  // 2. Dev API keys — insert each only if its hashed token isn't present yet.
  const hasher = createHasher(config.tokenPepper);
  const tokens: Record<ApiKeyKind, string> = {
    cma: config.cmaKey,
    cda: config.cdaKey,
    cpa: config.cpaKey,
  };
  for (const [kind, token] of Object.entries(tokens) as [ApiKeyKind, string][]) {
    // Unset (a deployment never gets dev keys): nothing to seed for this kind.
    if (!token) continue;
    const hashedToken = hasher.hash(token);
    if (!(await ctx.store.auth.findByHash(hashedToken))) {
      await ctx.store.auth.createApiKey({
        id: ctx.ids.newId(),
        spaceId: config.spaceId,
        kind,
        name: `dev-${kind}`,
        hashedToken,
        scopes: scopesForKind(kind),
        revoked: false,
      });
      logger.info({ kind }, 'seed: created dev api key');
    }
  }

  // 3. The enterprise brand in its own space (local dev only: off when `enterprise` is false).
  if (config.enterprise !== false) await seedEnterpriseSpace(ctx, config, deps);

  // 4. Rich demo dataset, short-circuited by the marker tag once complete.
  const tags = await listTags(ctx, scope);
  if (tags.some((t) => t.name === MARKER_TAG)) return;

  await seedContentModel(run);
  const assetIds = deps.blob ? await seedAssets(run, deps.blob) : [];
  const taxonomy = await seedTaxonomy(run);
  const corpus = await seedCorpus(run, assetIds, taxonomy);
  const releases = await seedReleases(run, corpus.articleIds, corpus.productIds);
  await seedCollaboration(run, corpus.articleIds);
  await seedAutomation(
    run,
    releases.autumnReleaseId,
    corpus.draftArticleIds[0] ?? null,
    // An article deep in the published set, so the scheduled unpublish never
    // collides with the entries used by workflows/comments/reviews demos.
    corpus.publishedArticleIds[20] ?? null,
  );
  await seedAgents(run, corpus.articleIds);
  await seedGovernance(run, config);

  await createTag(ctx, scope, { name: MARKER_TAG });
  logger.info({ scale: run.scale }, 'seed: demo dataset complete');
}

/**
 * The enterprise starter's brand in its own space beside the demo dataset, for local dev: installed
 * in process (a local request has no D1 call limit), once; the marker tag, written last, makes
 * every later boot one query.
 */
async function seedEnterpriseSpace(ctx: AppContext, config: SeedConfig, deps: SeedDeps) {
  const scope = { spaceId: ENTERPRISE_DEV_SPACE, environmentId: 'main' };
  if (await spaceExists(ctx, scope)) {
    if ((await listTags(ctx, scope)).some((t) => t.name === ENTERPRISE_MARKER_TAG)) return;
  } else {
    await createSpace(
      ctx,
      enterpriseSpaceInput({ spaceId: scope.spaceId, name: 'Aldermoor', defaultLocale: 'en-US' }),
    );
  }
  await installEnterpriseNow(ctx, scope, deps);
  await createTag(ctx, scope, { name: ENTERPRISE_MARKER_TAG });
  logger.info({ space: scope.spaceId, from: config.spaceId }, 'seed: enterprise space complete');
}

async function spaceExists(ctx: AppContext, scope: { spaceId: string; environmentId: string }) {
  try {
    await getSpaceConfig(ctx, scope);
    return true;
  } catch {
    return false;
  }
}
