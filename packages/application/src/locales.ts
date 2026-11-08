import {
  assertLocaleSettings,
  authorize,
  isLocaleDelivered,
  type LocaleCode,
  type LocaleSettings,
  NotFoundError,
  type Principal,
  resolvedLocaleSettings,
  SCOPES,
  type Scope,
} from '@commerceworker/domain';
import { type SpaceConfig, TransactionConflictError } from '@commerceworker/ports';
import type { AppContext } from './context';

/**
 * The space's config with every locale's settings resolved: whether Delivery serves it and which
 * way its text runs (a locale nothing was set for is delivered, in its language's direction). What
 * `GET …/space-config` serves, so a client reads one answer instead of re-deriving the defaults.
 */
export type SpaceLocalesView = SpaceConfig & {
  readonly localeSettings: Readonly<Record<LocaleCode, Required<LocaleSettings>>>;
};

async function requireConfig(ctx: AppContext, scope: Scope): Promise<SpaceConfig> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return config;
}

const viewOf = (config: SpaceConfig): SpaceLocalesView => ({
  ...config,
  localeSettings: resolvedLocaleSettings(config),
});

export async function getLocaleSettings(ctx: AppContext, scope: Scope): Promise<SpaceLocalesView> {
  return viewOf(await requireConfig(ctx, scope));
}

/**
 * Sets the space's per-locale settings: each locale named is replaced, the others keep theirs.
 * A locale not delivered stays editable and previewable, and Delivery stops serving it: a request
 * naming it is 404, fallback chains skip it, all-locale responses and the sitemap's alternates
 * leave it out. The default locale can't be turned off. Needs `space:admin`.
 *
 * The change and its `space_locales.changed` event are one unit, so the engine purges every
 * environment's delivery caches exactly when it commits.
 */
export async function setLocaleSettings(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  changes: Readonly<Record<string, unknown>>,
): Promise<SpaceLocalesView> {
  authorize(principal, SCOPES.spaceAdmin, scope.spaceId);
  for (let attempt = 1; ; attempt++) {
    const config = await requireConfig(ctx, scope);
    const valid = assertLocaleSettings(config, changes);
    // Only the space's current locales are kept: a locale removed since leaves its settings behind.
    const next: Record<LocaleCode, LocaleSettings> = {};
    for (const locale of config.locales) {
      const setting = locale in valid ? valid[locale] : config.localeSettings?.[locale];
      if (setting && Object.keys(setting).length > 0) next[locale] = setting;
    }
    const updated = { ...config, localeSettings: next };
    try {
      await ctx.store.withTransaction(async (tx) => {
        // Only over the settings just read: two admins changing different locales at once both
        // land, the second re-read on top of the first instead of writing over it.
        await tx.spaces.setLocaleSettings(scope.spaceId, next, config.localeSettings);
        await tx.outbox.append({
          id: ctx.ids.newId(),
          type: 'space_locales.changed',
          scope,
          occurredAt: ctx.clock.now().toISOString(),
          undelivered: config.locales.filter((l) => !isLocaleDelivered(updated, l)),
        });
      });
      return viewOf(updated);
    } catch (err) {
      if (!(err instanceof TransactionConflictError) || attempt >= MAX_ATTEMPTS) throw err;
    }
  }
}

/** Tries before a change that keeps losing the race to others gives up (as a conflict). */
const MAX_ATTEMPTS = 3;
