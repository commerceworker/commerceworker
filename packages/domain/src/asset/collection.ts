import { ValidationError } from '../errors';

/**
 * A collection: a named, curated set of assets in an order an editor chose. Unlike a folder, which
 * files each asset in exactly one place, an asset may sit in any number of collections, and a
 * collection holds assets from anywhere in the library. Environment-scoped, like the assets in it.
 */
export interface AssetCollection {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** How many assets it holds (every status: an archived member still counts). */
  readonly itemCount: number;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly updatedAt: string;
}

/** One membership: the asset, its place in the collection (0 first) and when it was added. */
export interface AssetCollectionItem {
  readonly assetId: string;
  readonly position: number;
  readonly addedAt: string;
}

/** Most assets one collection holds, so a listing, a reorder and a zip of it stay bounded. */
export const MAX_COLLECTION_ITEMS = 1000;
/** Most assets one add, remove or reorder names. The ids ride as one JSON parameter. */
export const MAX_COLLECTION_CHANGE = 500;
export const MAX_COLLECTION_DESCRIPTION = 1000;

/** Trims and checks a collection name: 1..128 characters. */
export function assetCollectionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new ValidationError([
      { field: 'name', message: 'Collection names are 1 to 128 characters' },
    ]);
  }
  return trimmed;
}

/** Trims a description; empty means none. */
export function assetCollectionDescription(description: string): string | undefined {
  const trimmed = description.trim();
  if (trimmed.length > MAX_COLLECTION_DESCRIPTION) {
    throw new ValidationError([
      {
        field: 'description',
        message: `A description is at most ${MAX_COLLECTION_DESCRIPTION} characters`,
      },
    ]);
  }
  return trimmed || undefined;
}

/**
 * The asset ids an add, remove or reorder names: deduplicated, in the order given, between 1 and
 * `max` ({@link MAX_COLLECTION_CHANGE}; a reorder takes a whole collection's order).
 */
export function collectionChangeIds(ids: readonly string[], max = MAX_COLLECTION_CHANGE): string[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > max) {
    throw new ValidationError([{ field: 'assetIds', message: `Name between 1 and ${max} assets` }]);
  }
  return unique;
}

/** What a share link opens: one asset, or a collection. */
export type AssetShareTargetType = 'asset' | 'collection';

/**
 * An expiring link to one asset or a collection, for someone without an account. It opens a
 * read-only page on the media origin that lists what the target publishes now (never a draft) and
 * serves those files. A link stops working when it expires or is revoked; neither is undone.
 */
export interface AssetShareLink {
  readonly id: string;
  readonly targetType: AssetShareTargetType;
  readonly targetId: string;
  readonly expiresAt: string;
  /** Whether the page offers the files as downloads (otherwise they open inline only). */
  readonly allowDownload: boolean;
  /** Whether the page asks for a password first. The hash itself never leaves the store. */
  readonly hasPassword: boolean;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly revokedAt?: string;
  /** The link to hand out, on the media origin (absent where no media origin is configured). */
  readonly url?: string;
}

/** A share link as stored: with its password hash (PBKDF2), which only the media origin reads. */
export interface StoredAssetShareLink extends Omit<AssetShareLink, 'hasPassword' | 'url'> {
  readonly passwordHash?: string;
}

/** Shortest and longest life a share link may be given. */
export const MIN_SHARE_LINK_SECONDS = 5 * 60;
export const MAX_SHARE_LINK_SECONDS = 90 * 24 * 60 * 60;
/** Shortest password a link takes, and longest (PBKDF2 hashes whatever it gets). */
export const MIN_SHARE_PASSWORD = 8;
export const MAX_SHARE_PASSWORD = 256;

/** Where a link stands at `nowMs`. */
export function shareLinkState(
  link: Pick<StoredAssetShareLink, 'expiresAt' | 'revokedAt'>,
  nowMs: number,
): 'active' | 'expired' | 'revoked' {
  if (link.revokedAt) return 'revoked';
  return Date.parse(link.expiresAt) > nowMs ? 'active' : 'expired';
}

/** Checks a requested expiry against `now`: in the future by 5 minutes to 90 days. */
export function shareLinkExpiry(expiresAt: string, now: Date): string {
  const at = Date.parse(expiresAt);
  const seconds = (at - now.getTime()) / 1000;
  if (
    !Number.isFinite(at) ||
    seconds < MIN_SHARE_LINK_SECONDS ||
    seconds > MAX_SHARE_LINK_SECONDS
  ) {
    throw new ValidationError([
      {
        field: 'expiresAt',
        message: 'A share link expires between 5 minutes and 90 days from now',
      },
    ]);
  }
  return new Date(at).toISOString();
}

/** Checks a share link's password length (it is hashed, never kept). */
export function shareLinkPassword(password: string): string {
  if (password.length < MIN_SHARE_PASSWORD || password.length > MAX_SHARE_PASSWORD) {
    throw new ValidationError([
      {
        field: 'password',
        message: `A password is ${MIN_SHARE_PASSWORD} to ${MAX_SHARE_PASSWORD} characters`,
      },
    ]);
  }
  return password;
}

/** What a zip download is made of: a selection of assets, or a collection's members. */
export type AssetZipSource =
  | { readonly kind: 'selection'; readonly assetIds: readonly string[] }
  | { readonly kind: 'collection'; readonly collectionId: string };

export type AssetZipStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * A zip download being built (or built): the selected assets' current files, stored (not
 * compressed) in one archive in blob storage, which a short-lived signed URL then serves.
 */
export interface AssetZipJob {
  readonly id: string;
  readonly status: AssetZipStatus;
  readonly source: AssetZipSource;
  /** The archive's file name (`<name>.zip`). */
  readonly fileName: string;
  /** Files in the archive, and the archive's length, once planned. */
  readonly fileCount?: number;
  readonly totalBytes?: number;
  /** Parts written of `partCount`: the job's progress. */
  readonly partsDone: number;
  readonly partCount?: number;
  readonly error?: string;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly completedAt?: string;
  /** When the archive is removed; its download URL stops working then. */
  readonly expiresAt: string;
  /** A short-lived signed URL for the finished archive (read time only, never stored). */
  readonly downloadUrl?: string;
}

/**
 * Most assets one zip takes (a whole collection, at its cap), so its plan fits well inside one
 * Workflow step's result (1 MiB).
 */
export const MAX_ZIP_ASSETS = 1000;
/** How long a finished archive is kept. */
export const ZIP_RETENTION_SECONDS = 24 * 60 * 60;

/** A zip's file name from a person's: a safe, short name ending in `.zip`. */
export function zipFileName(name: string | undefined, fallback: string): string {
  const base = (name ?? '')
    .replace(/\.zip$/i, '')
    .replace(/[^\p{L}\p{N} ._-]+/gu, '-')
    .trim()
    .slice(0, 100);
  return `${base || fallback}.zip`;
}

/** What a share-link path on the media origin asks for. */
export type ShareLinkRequest =
  | { readonly kind: 'page' }
  | { readonly kind: 'unlock' }
  | { readonly kind: 'file'; readonly assetId: string; readonly fileName: string };

export interface ShareLinkAddress {
  readonly scope: { readonly spaceId: string; readonly environmentId: string };
  readonly linkId: string;
  readonly token: string;
  readonly request: ShareLinkRequest;
}

/** A share-link token: 22 base64url characters (a 128-bit MAC). */
const LINK_TOKEN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Parses a share-link path: `/s/<space>/<env>/<linkId>/<token>` (the page),
 * `…/<token>/unlock` (a password), or `…/<token>/f/<assetId>/<fileName>` (one file). Never 8
 * segments, so no share path is ever read as a published asset's (which always is). `null` for
 * anything else; the token is checked by the caller before any lookup.
 */
export function parseShareLinkPath(pathname: string): ShareLinkAddress | null {
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 's') return null;
  const [, , space, env, link, token, ...rest] = parts;
  if (!LINK_TOKEN.test(token ?? '')) return null;
  let request: ShareLinkRequest;
  if (rest.length === 0) request = { kind: 'page' };
  else if (rest.length === 1 && rest[0] === 'unlock') request = { kind: 'unlock' };
  else if (rest.length === 3 && rest[0] === 'f')
    request = { kind: 'file', assetId: '', fileName: '' };
  else return null;
  try {
    const decoded = [space, env, link, ...(request.kind === 'file' ? rest.slice(1) : [])].map((s) =>
      decodeURIComponent(s ?? ''),
    );
    if (decoded.some((s) => s === '' || s === '.' || s === '..')) return null;
    const [spaceId, environmentId, linkId, assetId, fileName] = decoded as [
      string,
      string,
      string,
      string?,
      string?,
    ];
    return {
      scope: { spaceId, environmentId },
      linkId,
      token: token as string,
      request:
        request.kind === 'file'
          ? { kind: 'file', assetId: assetId as string, fileName: fileName as string }
          : request,
    };
  } catch {
    return null;
  }
}
