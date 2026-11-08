import {
  type Entry,
  type EntryKeyset,
  entryKeysetOf,
  entrySysOf,
  keysetOrder,
  NotFoundError,
  projectFields,
  type QueryOrder,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type { EntryQuery } from '@commerceworker/ports';
import { type AppContext, actorOf } from './context';
import { localeFallbackChain, type RenderOptions } from './delivery';
import { resolveMe, usesReferenceFilters } from './entry-query';
import { renderFields } from './render';

/**
 * Who created an entry and changed it last, when it was created and first published: the
 * `sys.createdBy`, `sys.updatedBy`, `sys.createdAt` and `sys.firstPublishedAt` a list filters and
 * sorts on. Null when unknown (an entry from before authorship was recorded, or never published).
 */
export interface EntryAuthorship {
  readonly createdAt: string | null;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly firstPublishedAt: string | null;
}

export const authorshipOf = (entry: Entry): EntryAuthorship => ({
  createdAt: entry.createdAt ?? null,
  createdBy: entry.createdBy ?? null,
  updatedBy: entry.updatedBy ?? null,
  firstPublishedAt: entry.firstPublishedAt ?? null,
});

/** A previewed entry: the current (draft) version, including its status and authorship. */
export interface PreviewedEntry extends EntryAuthorship {
  readonly id: string;
  readonly contentType: string;
  readonly status: string;
  readonly version: number;
  readonly fields: Record<string, unknown>;
}

async function spaceConfig(ctx: AppContext, scope: Scope) {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return config;
}

/**
 * Read path for the Preview API (CPA). Serves the current/draft version of an
 * entry — what an editor sees before publishing — rather than the published
 * snapshot.
 */
export async function getPreviewEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: RenderOptions = {},
): Promise<PreviewedEntry> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  const config = await spaceConfig(ctx, scope);
  return {
    id: found.entry.id,
    contentType: found.entry.contentTypeApiId,
    status: found.entry.status,
    version: found.entry.currentVersion,
    ...authorshipOf(found.entry),
    fields: renderFields(found.fields, config, opts.locale),
  };
}

/**
 * A singleton type's entry as it is now (`GET /preview/…/singletons/:apiId`): its current version,
 * a draft included, as {@link getPreviewEntry} serves one. Not found unless `apiId` names a
 * singleton type with an entry outside the trash.
 */
export async function getPreviewSingleton(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
  opts: RenderOptions = {},
): Promise<PreviewedEntry> {
  const [contentType, [found], config] = await Promise.all([
    ctx.store.contentTypes.get(scope, apiId),
    ctx.store.entries.list(scope, { contentTypeApiId: apiId, limit: 1 }),
    spaceConfig(ctx, scope),
  ]);
  if (!contentType?.singleton) throw new NotFoundError('Singleton', apiId);
  if (!found) throw new NotFoundError('Singleton entry', apiId);
  return {
    id: found.entry.id,
    contentType: found.entry.contentTypeApiId,
    status: found.entry.status,
    version: found.entry.currentVersion,
    ...authorshipOf(found.entry),
    fields: renderFields(found.fields, config, opts.locale),
  };
}

export async function listPreviewEntries(
  ctx: AppContext,
  scope: Scope,
  query: EntryQuery = {},
  opts: RenderOptions = {},
): Promise<PreviewedEntry[]> {
  const config = await spaceConfig(ctx, scope);
  const locale = query.locale ?? opts.locale ?? config.defaultLocale;
  const rows = await ctx.store.entries.list(scope, {
    ...query,
    ...(usesReferenceFilters(query)
      ? { contentTypes: await ctx.store.contentTypes.list(scope) }
      : {}),
    locale,
    fallbackLocales: localeFallbackChain(config, locale),
  });
  return rows.map((found) => ({
    id: found.entry.id,
    contentType: found.entry.contentTypeApiId,
    status: found.entry.status,
    version: found.entry.currentVersion,
    ...authorshipOf(found.entry),
    fields: renderFields(found.fields, config, opts.locale),
  }));
}

/** A row of a paged preview list: the previewed entry and when it last changed. */
export interface ListedPreviewEntry extends PreviewedEntry {
  /** When the entry last changed (ISO-8601). */
  readonly updatedAt?: string;
}

/** One page of the preview list; pass `nextCursor` back as `cursor` for the next. */
export interface PreviewEntryPage {
  readonly items: readonly ListedPreviewEntry[];
  readonly nextCursor?: string;
}

/** The most entries one page holds, and what a page holds when the caller names no limit. */
export const PREVIEW_ENTRY_PAGE_MAX = 100;

/** What a cursor is for: the order it walks, so a cursor from another sort is refused. */
const orderSignature = (order: readonly QueryOrder[]) =>
  order.map((o) => `${o.direction === 'desc' ? '-' : ''}${o.field}`).join(',');

// base64url, so a cursor pasted into a URL unencoded survives (`+` would arrive as a space).
function encodeEntryCursor(order: readonly QueryOrder[], key: EntryKeyset): string {
  const json = JSON.stringify([orderSignature(order), key.values, key.id]);
  return btoa(encodeURIComponent(json)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeEntryCursor(order: readonly QueryOrder[], cursor: string): EntryKeyset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))));
  } catch {
    // Falls through to the refusal.
  }
  if (
    Array.isArray(parsed) &&
    parsed.length === 3 &&
    parsed[0] === orderSignature(order) &&
    Array.isArray(parsed[1]) &&
    parsed[1].length === order.length &&
    typeof parsed[2] === 'string'
  ) {
    return { values: parsed[1], id: parsed[2] };
  }
  throw new ValidationError([
    { field: 'cursor', message: 'cursor is not one this list returned for this order' },
  ]);
}

/**
 * One page of the Preview list, walked with a keyset cursor in the list's own order (`order`,
 * or least recently changed first). In the default order an entry edited between two reads is
 * never skipped, as it would be by an offset; under another order, an edit to a sorted field can
 * move an entry across the cursor. Same reads as {@link listPreviewEntries}: one row past the
 * page says whether another follows.
 *
 * `readable` is the caller's content-type grant. Its types are filtered in the query itself
 * (one more read, of the content types), so a page never ends on, and a cursor never carries the
 * values of, an entry the caller may not see.
 */
export async function listPreviewEntryPage(
  ctx: AppContext,
  scope: Scope,
  query: Omit<EntryQuery, 'afterRow' | 'afterEntryId' | 'after' | 'skip'> & {
    readonly cursor?: string;
  } = {},
  opts: RenderOptions & { readonly readable?: (contentType: string) => boolean } = {},
): Promise<PreviewEntryPage> {
  const { cursor, select, ...asked } = query;
  // `sys.createdBy=me`: the caller is whoever `ctx` acts for.
  const rest = resolveMe(asked, actorOf(ctx));
  let filters = rest.filters;
  if (opts.readable) {
    const readable = opts.readable;
    if (rest.contentTypeApiId !== undefined) {
      if (!readable(rest.contentTypeApiId)) return { items: [] };
    } else {
      const types = (await ctx.store.contentTypes.list(scope)).map((t) => t.apiId);
      const allowed = types.filter(readable);
      if (allowed.length === 0) return { items: [] };
      if (allowed.length < types.length)
        filters = [...(filters ?? []), { field: 'sys.contentType', op: 'in', value: allowed }];
    }
  }
  const order = keysetOrder(rest.order);
  const afterRow = cursor ? decodeEntryCursor(order, cursor) : 'start';
  const limit = Math.min(Math.max(1, rest.limit ?? PREVIEW_ENTRY_PAGE_MAX), PREVIEW_ENTRY_PAGE_MAX);
  const config = await spaceConfig(ctx, scope);
  const locale = rest.locale ?? opts.locale ?? config.defaultLocale;
  const fallbackLocales = localeFallbackChain(config, locale);
  // A reference filter is answered from the links the content model declares (as on Delivery).
  const contentTypes = usesReferenceFilters(rest)
    ? await ctx.store.contentTypes.list(scope)
    : undefined;
  // A projection still reads the ordered fields: the cursor is built from them.
  const ordered = order.flatMap((o) =>
    o.field.startsWith('sys.') || o.field.startsWith('metadata.') ? [] : [o.field],
  );
  const rows = await ctx.store.entries.list(scope, {
    ...rest,
    ...(filters ? { filters } : {}),
    ...(select ? { select: [...new Set([...select, ...ordered])] } : {}),
    limit: limit + 1,
    afterRow,
    locale,
    fallbackLocales,
    ...(contentTypes ? { contentTypes } : {}),
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const sysOf = (r: (typeof rows)[number]) => entrySysOf(r.entry, r.updatedAt);
  return {
    items: page.map((found) => ({
      id: found.entry.id,
      contentType: found.entry.contentTypeApiId,
      status: found.entry.status,
      version: found.entry.currentVersion,
      ...(found.updatedAt ? { updatedAt: found.updatedAt } : {}),
      ...authorshipOf(found.entry),
      fields: renderFields(
        select ? projectFields(found.fields, select) : found.fields,
        config,
        opts.locale,
      ),
    })),
    ...(rows.length > limit && last
      ? {
          nextCursor: encodeEntryCursor(
            order,
            entryKeysetOf(order, last.fields, sysOf(last), locale, fallbackLocales),
          ),
        }
      : {}),
  };
}

/** One entry, reduced to what a chooser shows. */
export interface EntrySuggestion {
  readonly id: string;
  readonly contentType: string;
  readonly status: string;
  /** The display field's value in the requested locale, or the id when it has none. */
  readonly title: string;
}

/** How many suggestions one call returns, and the ceiling a caller can ask for. */
export const SUGGEST_DEFAULT_LIMIT = 20;
export const SUGGEST_MAX_LIMIT = 50;

export interface SuggestEntriesInput {
  /** What the person has typed so far. Empty returns the most recent entries. */
  readonly q?: string;
  /** Restrict to one content type — which is what a reference field always wants. */
  readonly contentTypeApiId?: string;
  readonly locale?: string;
  readonly limit?: number;
}

/**
 * Entries matching what someone is typing, resolved server-side.
 *
 * This exists because a chooser cannot be built by listing entries and
 * filtering in the browser: the list endpoint is capped, so on a space with
 * more entries than one page, the ones past the cap are simply unreachable —
 * not slow to find, *impossible* to pick. Matching where the data is turns a
 * silent ceiling into an ordinary query.
 *
 * Matches on the content type's display field, because that is the string a
 * person is typing when they are looking for an entry. Cross-type search over
 * every field is a different question, and the search endpoints answer it.
 */
export async function suggestEntries(
  ctx: AppContext,
  scope: Scope,
  input: SuggestEntriesInput = {},
): Promise<EntrySuggestion[]> {
  const limit = Math.min(Math.max(input.limit ?? SUGGEST_DEFAULT_LIMIT, 1), SUGGEST_MAX_LIMIT);
  const config = await spaceConfig(ctx, scope);
  const locale = input.locale ?? config.defaultLocale;

  const types = input.contentTypeApiId
    ? [await ctx.store.contentTypes.get(scope, input.contentTypeApiId)].filter(
        (t): t is NonNullable<typeof t> => t !== null,
      )
    : await ctx.store.contentTypes.list(scope);
  if (types.length === 0) return [];

  const q = input.q?.trim() ?? '';
  // One query per content type, because the field to match on is per type.
  // Bounded by the number of types in a space, which is a modelling decision
  // rather than a data volume — unlike entries, which is why this is not the
  // shape that was failing.
  const perType = await Promise.all(
    types.map(async (type) => {
      const entries = await ctx.store.entries.list(scope, {
        contentTypeApiId: type.apiId,
        limit,
        archived: false,
        ...(q ? { filters: [{ field: type.displayField, op: 'match' as const, value: q }] } : {}),
      });
      return entries.map((found) => ({
        id: found.entry.id,
        contentType: type.apiId,
        status: found.entry.status,
        title: titleOf(found.fields[type.displayField], locale, config, found.entry.id),
      }));
    }),
  );

  return perType.flat().slice(0, limit);
}

/** The display value a person recognises, or the id when the field is empty. */
function titleOf(
  value: unknown,
  locale: string,
  config: { defaultLocale: string; locales: readonly string[]; fallbacks?: unknown },
  fallback: string,
): string {
  const localized = value as Record<string, unknown> | undefined;
  const resolved = localized?.[locale] ?? localized?.[config.defaultLocale];
  return typeof resolved === 'string' && resolved ? resolved : fallback;
}
