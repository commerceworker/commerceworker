import {
  ConflictError,
  type DomainEvent,
  ForbiddenError,
  InvalidStateError,
  isReservedSpaceId,
  isSpaceId,
  type LocaleCode,
  NotFoundError,
  type Principal,
  RESERVED_SPACE_IDS,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import {
  type EnvironmentAlias,
  type SpaceConfig,
  TransactionConflictError,
} from '@commerceworker/ports';
import { auditActor } from './audit';
import type { AppContext } from './context';
import { purgeDue } from './environment-purge';
import { ensureRolePresets } from './team';
import { spacesForSubject } from './web-principal';

export interface CreateSpaceInput {
  readonly spaceId: string;
  readonly name: string;
  readonly defaultLocale: LocaleCode;
  readonly locales?: readonly LocaleCode[];
  readonly fallbacks?: Record<LocaleCode, LocaleCode | null>;
  /** Environments to create alongside the space. Defaults to ["main"]. */
  readonly environments?: readonly string[];
}

/**
 * Provisions a space with its locales and one or more environments. This is the
 * entry point that lets the platform be set up over the API instead of by hand.
 */
export async function createSpace(ctx: AppContext, input: CreateSpaceInput): Promise<SpaceConfig> {
  if (!isSpaceId(input.spaceId)) {
    throw new ValidationError([
      {
        field: 'spaceId',
        message:
          'A space id is 1–64 letters, digits, ".", "_" or "-", starting with a letter or digit',
      },
    ]);
  }
  if (isReservedSpaceId(input.spaceId)) {
    throw new ValidationError([
      {
        field: 'spaceId',
        message: `"${input.spaceId}" is reserved for the bucket's own data; reserved ids are ${RESERVED_SPACE_IDS.join(', ')}`,
      },
    ]);
  }
  const locales = input.locales?.length ? input.locales : [input.defaultLocale];
  if (!locales.includes(input.defaultLocale)) {
    throw new ValidationError([
      { field: 'defaultLocale', message: 'defaultLocale must be included in locales' },
    ]);
  }
  const config: SpaceConfig = {
    spaceId: input.spaceId,
    name: input.name,
    defaultLocale: input.defaultLocale,
    locales,
    fallbacks: input.fallbacks,
  };
  await ctx.store.spaces.create(config);
  const environments = input.environments?.length ? input.environments : ['main'];
  for (const env of environments) {
    await ctx.store.spaces.createEnvironment(input.spaceId, env, env);
  }
  // Every space starts with the built-in role presets (Viewer … Administrator).
  await ensureRolePresets(ctx, input.spaceId);
  return config;
}

/** Reads a space's configuration (locales, default locale, fallbacks). */
export async function getSpaceConfig(ctx: AppContext, scope: Scope): Promise<SpaceConfig> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return config;
}

/** All spaces (admin view). */
export async function listSpaces(ctx: AppContext): Promise<SpaceConfig[]> {
  return ctx.store.spaces.list();
}

/**
 * The spaces a principal can reach: every space for a deployment-wide one (the root tokens, a
 * signed-in deployment admin), the teams a signed-in member is on when the request names no
 * space, else the one space its credential is bound to.
 */
export async function listSpacesFor(ctx: AppContext, principal: Principal): Promise<SpaceConfig[]> {
  const spaces = await ctx.store.spaces.list();
  if (principal.spaceId === '*') return spaces;
  const own =
    principal.kind === 'user' && !principal.spaceId && principal.subject
      ? new Set(await spacesForSubject(ctx, principal.subject))
      : new Set([principal.spaceId]);
  return spaces.filter((s) => own.has(s.spaceId));
}

/** Adds an environment (branch) to an existing space. */
export async function createEnvironment(
  ctx: AppContext,
  spaceId: string,
  environmentId: string,
  name?: string,
): Promise<void> {
  try {
    await ctx.store.spaces.createEnvironment(spaceId, environmentId, name ?? environmentId);
  } catch (err) {
    // A deleted environment of this id still has rows being removed; the new one would get them.
    if (err instanceof TransactionConflictError) {
      throw new ConflictError(
        `Environment "${environmentId}" was deleted and is still being removed; try again shortly`,
      );
    }
    throw err;
  }
}

/** Lists a space's environments (branches). */
export async function listEnvironments(ctx: AppContext, spaceId: string) {
  return ctx.store.spaces.listEnvironments(spaceId);
}

/** Entry ids per `environment.deleted` event (keeps each outbox row and queue message small). */
export const ENVIRONMENT_DELETED_CHUNK = 500;

export interface DeletedEnvironment {
  readonly environmentId: string;
  /** Published entries whose search documents and vectors the engine removes. */
  readonly publishedEntries: number;
}

/**
 * Deletes an environment and everything in it (its audit history stays). Refuses `main`, an
 * unknown environment, and one an alias points at (repoint or remove the alias first, so delivery
 * under the alias never breaks). One atomic write takes it out of the registry, so it stops
 * resolving at once, with `environment.deleted` events (from which the engine removes the
 * published entries' search documents and vectors and purges the delivery cache) and the first
 * `environment.purge_due`, which removes its rows and files in bounded steps
 * (`runEnvironmentPurge`). `confirm` must repeat the environment's id: deleting one is
 * irreversible, and an agent (or a script) shouldn't do it by a slip of an argument.
 */
export async function deleteEnvironment(
  ctx: AppContext,
  spaceId: string,
  environmentId: string,
  opts: { readonly confirm?: string; readonly principal: Principal },
): Promise<DeletedEnvironment> {
  // A person (signed in, or through their own token) or the deployment admin token: never a plain
  // API key, even one holding space:admin, since integration and CI keys routinely do, and an agent
  // steered into calling this can supply `confirm` as easily as anything else.
  if (opts.principal.kind !== 'user' && opts.principal.kind !== 'admin') {
    throw new ForbiddenError(
      'Deleting an environment takes a person or the deployment admin token, not an API key',
    );
  }
  if (opts.confirm !== environmentId) {
    throw new ValidationError([
      {
        field: 'confirm',
        message: `Deleting an environment is irreversible: pass confirm="${environmentId}" to proceed`,
      },
    ]);
  }
  if (environmentId === 'main') {
    throw new ValidationError([
      { field: 'environmentId', message: 'The main environment cannot be deleted' },
    ]);
  }
  const environments = await ctx.store.spaces.listEnvironments(spaceId);
  if (!environments.some((e) => e.id === environmentId)) {
    throw new NotFoundError('Environment', environmentId);
  }
  const aliases = (await ctx.store.spaces.listAliases(spaceId)).filter(
    (a) => a.targetEnvironmentId === environmentId,
  );
  if (aliases.length > 0) {
    throw new ConflictError(
      `Environment "${environmentId}" is the target of ${aliases.map((a) => `"${a.alias}"`).join(', ')}; repoint or remove the alias first`,
    );
  }

  const scope: Scope = { spaceId, environmentId };
  // Keyset pages (entry ids are time-ordered UUIDv7s), so an entry published meanwhile can't
  // shift another out of a page the way offsets would.
  const ids: string[] = [];
  for (let after = ''; ; ) {
    const page = await ctx.store.entries.listPublished(scope, {
      limit: 500,
      afterEntryId: after,
    });
    ids.push(...page.map((p) => p.entryId));
    if (page.length < 500) break;
    after = page[page.length - 1]?.entryId ?? after;
  }
  const occurredAt = ctx.clock.now().toISOString();
  const chunks: string[][] = [];
  for (let at = 0; at < ids.length; at += ENVIRONMENT_DELETED_CHUNK) {
    chunks.push(ids.slice(at, at + ENVIRONMENT_DELETED_CHUNK));
  }
  // At least one event, even for an empty environment: its delivery cache is purged either way.
  const events: DomainEvent[] = [
    ...(chunks.length > 0 ? chunks : [[]]).map((entryIds) => ({
      id: ctx.ids.newId(),
      type: 'environment.deleted' as const,
      scope,
      occurredAt,
      entryIds,
    })),
    purgeDue(ctx, scope),
  ];
  // Recorded in the same write as the deletion, whichever surface asked: it can't commit unrecorded.
  const audit = {
    id: ctx.ids.newId(),
    spaceId,
    environmentId,
    actor: auditActor(opts.principal),
    action: 'environment.deleted',
    targetType: 'environment',
    targetId: environmentId,
    status: 200,
    at: occurredAt,
  };
  try {
    await ctx.store.spaces.deleteEnvironment(spaceId, environmentId, events, audit);
  } catch (err) {
    // An alias was pointed at it after the check above: the deletion did not happen.
    if (err instanceof TransactionConflictError) {
      throw new ConflictError(
        `An alias now points at "${environmentId}"; repoint or remove it, then delete again`,
      );
    }
    throw err;
  }
  return { environmentId, publishedEntries: ids.length };
}

// --- environment aliases (blue/green) --------------------------------------

async function requireEnvironment(ctx: AppContext, spaceId: string, environmentId: string) {
  const envs = await ctx.store.spaces.listEnvironments(spaceId);
  if (!envs.some((e) => e.id === environmentId)) {
    throw new NotFoundError('Environment', `${spaceId}/${environmentId}`);
  }
}

/**
 * Creates or atomically repoints an environment alias at a target environment.
 * Rejects an alias whose name collides with a real environment (so resolution is
 * never ambiguous) and a target that doesn't exist. Repointing is how blue/green
 * cutover works: flip the alias from the old env to the new one in one write.
 */
export async function setEnvironmentAlias(
  ctx: AppContext,
  spaceId: string,
  alias: string,
  targetEnvironmentId: string,
): Promise<EnvironmentAlias> {
  await requireEnvironment(ctx, spaceId, targetEnvironmentId);
  const envs = await ctx.store.spaces.listEnvironments(spaceId);
  if (envs.some((e) => e.id === alias)) {
    throw new InvalidStateError(
      `"${alias}" is already an environment; an alias cannot share its name`,
    );
  }
  const at = ctx.clock.now().toISOString();
  try {
    await ctx.store.spaces.setAlias(spaceId, alias, targetEnvironmentId, at);
  } catch (err) {
    // The target was deleted after the check above: nothing was aliased.
    if (err instanceof TransactionConflictError) {
      throw new NotFoundError('Environment', `${spaceId}/${targetEnvironmentId}`);
    }
    throw err;
  }
  await announceAliasChange(ctx, spaceId, alias, targetEnvironmentId);
  return { alias, targetEnvironmentId, updatedAt: at };
}

/** Lists a space's environment aliases. */
export async function listEnvironmentAliases(
  ctx: AppContext,
  spaceId: string,
): Promise<EnvironmentAlias[]> {
  return ctx.store.spaces.listAliases(spaceId);
}

export async function deleteEnvironmentAlias(
  ctx: AppContext,
  spaceId: string,
  alias: string,
): Promise<void> {
  if (!(await ctx.store.spaces.getAlias(spaceId, alias))) {
    throw new NotFoundError('EnvironmentAlias', `${spaceId}/${alias}`);
  }
  await ctx.store.spaces.deleteAlias(spaceId, alias);
  await announceAliasChange(ctx, spaceId, alias, null);
}

/**
 * Appends `environment_alias.changed` so caches keyed by the alias are purged. Appended after the
 * change rather than with it (the spaces repo is not part of a unit of work): if it is lost,
 * delivery under the alias goes stale only until its cached responses' max-age.
 */
async function announceAliasChange(
  ctx: AppContext,
  spaceId: string,
  alias: string,
  targetEnvironmentId: string | null,
): Promise<void> {
  await ctx.store.outbox.append({
    id: ctx.ids.newId(),
    type: 'environment_alias.changed',
    scope: { spaceId, environmentId: alias },
    occurredAt: ctx.clock.now().toISOString(),
    targetEnvironmentId,
  });
}

/**
 * Resolves an environment-or-alias name to a concrete environment id. If the
 * name is a registered alias it returns the alias target; otherwise it returns
 * the name unchanged (a direct environment reference). This is the single seam
 * the API uses so an alias works anywhere `:env` does.
 */
export async function resolveEnvironment(
  ctx: AppContext,
  spaceId: string,
  envOrAlias: string,
  opts: {
    /**
     * Refuse a deleted environment still being purged (default). The HTTP and MCP surfaces turn
     * this off for a caller who can't act in the space, whose request is refused 403 anyway, so
     * a 404 doesn't tell them an environment of that name was recently deleted.
     */
    readonly refusePurging?: boolean;
  } = {},
): Promise<string> {
  const { targetEnvironmentId, purging } = await ctx.store.spaces.resolveName(spaceId, envOrAlias);
  if (targetEnvironmentId) return targetEnvironmentId;
  // A deleted environment whose rows are still being removed: what is left must not be served.
  if (purging && opts.refusePurging !== false) {
    throw new NotFoundError('Environment', `${spaceId}/${envOrAlias}`);
  }
  return envOrAlias;
}

/**
 * Like {@link resolveEnvironment}, but refuses a name that is neither an alias nor a registered
 * environment (`NotFoundError`). Every write resolves through this, so a typo'd or deleted
 * environment gets a 404 instead of rows no environment owns.
 */
export async function resolveWritableEnvironment(
  ctx: AppContext,
  spaceId: string,
  envOrAlias: string,
): Promise<string> {
  const resolved = await resolveEnvironment(ctx, spaceId, envOrAlias);
  if (resolved !== envOrAlias) return resolved;
  await requireEnvironment(ctx, spaceId, envOrAlias);
  return envOrAlias;
}
