import { withReadUrl } from '@commerceworker/application';
import type { Asset, AssetVersion, Scope } from '@commerceworker/domain';
import type { BlobStore } from '@commerceworker/ports';

/**
 * Fields of a stored asset (and of each version in its history) that are the server's own
 * bookkeeping, not the contract: `r2Key` names where the bytes live in the bucket, which a client
 * has no use for and should not learn (it is the path a signed URL is minted for).
 */
export const SERVER_ONLY_ASSET_FIELDS = ['r2Key'] as const;

type ServerOnly = (typeof SERVER_ONLY_ASSET_FIELDS)[number];

/** An asset as the Management API and MCP send it. */
export type AssetResponse = Omit<Asset, ServerOnly>;
/** A version of an asset's file as the Management API and MCP send it. */
export type AssetVersionResponse = Omit<AssetVersion, ServerOnly>;

function withoutServerOnly<T extends { readonly r2Key?: string }>(value: T): Omit<T, ServerOnly> {
  const { r2Key: _key, ...rest } = value;
  return rest;
}

/**
 * The one serializer for an asset in a Management or MCP response: the server-only fields go, and
 * `file.url` becomes a short-lived signed read URL in place of the stored non-expiring one (a
 * hosted video keeps its playback URLs). Without a blob store (local fakes) there is nothing to sign
 * with, and the stored URL stays.
 */
export async function assetResponse(
  blob: BlobStore | undefined,
  scope: Scope,
  asset: Asset,
): Promise<AssetResponse> {
  return withoutServerOnly(blob ? await withReadUrl(blob, scope, asset) : asset);
}

/** {@link assetResponse} for a page of assets (`items`), keeping the page's other fields. */
export async function assetPageResponse<P extends { readonly items: readonly Asset[] }>(
  blob: BlobStore | undefined,
  scope: Scope,
  page: P,
): Promise<Omit<P, 'items'> & { items: AssetResponse[] }> {
  return {
    ...page,
    items: await Promise.all(page.items.map((a) => assetResponse(blob, scope, a))),
  };
}

/** A version of an asset's file, without the server-only fields. */
export function assetVersionResponse(version: AssetVersion): AssetVersionResponse {
  return withoutServerOnly(version);
}
