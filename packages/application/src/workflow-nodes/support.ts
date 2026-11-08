import {
  assertWritableFields,
  authorize,
  authorizeContent,
  type ContentAction,
  NotFoundError,
  type PermissionScope,
  type RunEntry,
  type Scope,
} from '@commerceworker/domain';
import type { AppContext } from '../context';
import type { ExecInput } from './types';

/**
 * The entry as run expressions see it (`entry.*`): status and versions, fields, tag names (the
 * vocabulary people write conditions in) and tag ids, and the display title.
 */
export async function loadRunEntry(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
): Promise<RunEntry> {
  const found = await ctx.store.entries.get(scope, entryId);
  if (!found) throw new NotFoundError('Entry', entryId);
  const [ct, config, metadata] = await Promise.all([
    ctx.store.contentTypes.get(scope, found.entry.contentTypeApiId),
    ctx.store.spaces.getConfig(scope),
    ctx.store.taxonomy.getEntryMetadata(scope, entryId),
  ]);
  const tagIds = [...(metadata?.tags ?? [])];
  const names = new Map((await ctx.store.taxonomy.listTags(scope)).map((t) => [t.id, t.name]));
  const locale = config?.defaultLocale ?? 'en-US';
  const titleField = ct ? found.fields[ct.displayField] : undefined;
  const title =
    titleField && typeof titleField[locale] === 'string'
      ? (titleField[locale] as string)
      : (Object.values(titleField ?? {}).find((v): v is string => typeof v === 'string') ?? '');
  return {
    id: found.entry.id,
    contentTypeApiId: found.entry.contentTypeApiId,
    status: found.entry.status,
    currentVersion: found.entry.currentVersion,
    publishedVersion: found.entry.publishedVersion,
    fields: JSON.parse(JSON.stringify(found.fields)) as Record<string, Record<string, unknown>>,
    tags: tagIds.map((id) => names.get(id) ?? id),
    tagIds,
    title,
  };
}

/**
 * The same checks the API applies to a person making this call: the coarse scope in the run's
 * space, the content-type grant for the action, and (for writes) the field rules. Throws
 * ForbiddenError, which fails the node without retries.
 */
export function guard(
  i: Pick<ExecInput, 'actor' | 'scope' | 'run'>,
  scope: PermissionScope,
  action: ContentAction,
  fields?: Record<string, unknown>,
): void {
  const principal = i.actor.principal;
  authorize(principal, scope, i.scope.spaceId);
  authorizeContent(principal, action, i.run.entry.contentTypeApiId);
  if (fields) assertWritableFields(principal, i.run.entry.contentTypeApiId, fields);
}

export const str = (v: unknown, fb = ''): string => (typeof v === 'string' ? v : fb);
export const num = (v: unknown, fb: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fb;
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Interpolates every string inside a JSON value (payloads, field values). */
export function interpolateDeep(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, fn));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, fn)]));
  }
  return value;
}

/** The space's default locale. */
export async function defaultLocaleOf(ctx: AppContext, scope: Scope): Promise<string> {
  return (await ctx.store.spaces.getConfig(scope))?.defaultLocale ?? 'en-US';
}
