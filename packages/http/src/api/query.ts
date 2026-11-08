/**
 * Parses the asset query strings (library, Delivery, search). The entry query language lives in
 * `@commerceworker/application` (`entryQueryFrom`), shared with the GraphQL resolvers.
 */

import { type AssetSearchQuery, clampCount, MAX_PAGE_LIMIT } from '@commerceworker/application';
import { ASSET_KINDS, type AssetKind, ValidationError } from '@commerceworker/domain';
import type { AssetListQuery } from '@commerceworker/ports';

const ASSET_STATUSES = ['draft', 'published', 'archived', 'all'] as const;
const ASSET_SORTS = ['updatedAt', 'createdAt', 'size'] as const;

/** Reads `value` as one of `allowed`, or refuses it naming the choices. */
function oneOf<T extends string>(
  field: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === '') return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ValidationError([{ field, message: `${field} must be one of ${allowed.join(', ')}` }]);
}

/**
 * The asset library's query string: `kind`, `mime` (`image/png` or `image/*`), `tag`, `folder`
 * (an id, or `root` for assets in no folder), `status` (`all` includes archived), `sort` and
 * `order`, `limit` and `cursor`.
 */
export function parseAssetListQuery(q: Record<string, string | undefined>): AssetListQuery {
  const kind = oneOf('kind', q.kind, ASSET_KINDS);
  const status = oneOf('status', q.status, ASSET_STATUSES);
  const field = oneOf('sort', q.sort, ASSET_SORTS);
  const direction = oneOf('order', q.order, ['asc', 'desc'] as const);
  const limit = clampCount(q.limit, MAX_PAGE_LIMIT, { min: 1 });
  const folder = q.folder === undefined || q.folder === '' ? undefined : q.folder;
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
    filters: {
      ...(kind ? { kind } : {}),
      ...(q.mime ? { mime: q.mime.slice(0, 256) } : {}),
      ...(q.tag ? { tag: q.tag.slice(0, 128) } : {}),
      ...(folder !== undefined ? { folderId: folder === 'root' ? null : folder } : {}),
      ...(status ? { status } : {}),
    },
    ...(field || direction
      ? { sort: { field: field ?? 'updatedAt', direction: direction ?? 'desc' } }
      : {}),
  };
}

/**
 * A Delivery or Preview asset listing from query parameters: `limit`, `cursor` (or `skip`),
 * `kind`, `tag`, and `folder` (an id, or `root` for assets in no folder).
 */
export function parseDeliveredAssetQuery(q: Record<string, string | undefined>): {
  limit?: number;
  skip?: number;
  cursor?: string;
  filters: { kind?: AssetKind; tag?: string; folderId?: string | null };
} {
  const kind = oneOf('kind', q.kind, ASSET_KINDS);
  const limit = clampCount(q.limit, MAX_PAGE_LIMIT, { min: 1 });
  const skip = clampCount(q.skip, Number.MAX_SAFE_INTEGER, { min: 0 });
  const folder = q.folder === undefined || q.folder === '' ? undefined : q.folder;
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(q.cursor ? { cursor: q.cursor } : skip ? { skip } : {}),
    filters: {
      ...(kind ? { kind } : {}),
      ...(q.tag ? { tag: q.tag.slice(0, 128) } : {}),
      ...(folder !== undefined ? { folderId: folder === 'root' ? null : folder } : {}),
    },
  };
}

/**
 * An asset search's query string: `q`, `limit`, and the filters `kind`, `tag`, `folder` (an id,
 * or `root`) and, for the library, `status` (`all` includes archived).
 */
export function parseAssetSearchQuery(q: Record<string, string | undefined>): AssetSearchQuery {
  const kind = oneOf('kind', q.kind, ASSET_KINDS);
  const status = oneOf('status', q.status, ASSET_STATUSES);
  const limit = clampCount(q.limit, MAX_PAGE_LIMIT, { min: 1 });
  const folder = q.folder === undefined || q.folder === '' ? undefined : q.folder;
  return {
    q: q.q ?? '',
    ...(limit !== undefined ? { limit } : {}),
    filters: {
      ...(kind ? { kind } : {}),
      ...(q.tag ? { tag: q.tag.slice(0, 128) } : {}),
      ...(folder !== undefined ? { folderId: folder === 'root' ? null : folder } : {}),
      ...(status ? { status } : {}),
    },
  };
}
