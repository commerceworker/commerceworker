/**
 * The asset reference route: `GET /a/<assetId>` and `GET /a/<assetId>/<variant>` answer 302 to the
 * published URL of the asset's current version. A product's media `asset:<assetId>` publishes as
 * the first form (the catalog), so a stored document never holds a version or a token and a
 * replaced file reaches shoppers without a reindex.
 *
 * The redirect names the same immutable, token-checked path every published file has
 * (`assetMediaPath`), so the bytes keep their year-long cache and the gate still decides whether
 * they are served. It reads the gate (KV, then a replica) and writes nothing. An asset that isn't
 * published, was never there, has no servable file (a hosted video) or is past its rights is the
 * same 404 (cached for 30 s, so probing unknown ids doesn't reach a replica each time), so a probe
 * learns nothing about which ids exist.
 */
import {
  type AssetVariant,
  assetMediaPath,
  isTransformableImage,
  ORIGINAL,
  parseAssetVariant,
  type Scope,
} from '@commerceworker/domain';
import type { AssetGate, ContentStore, MediaPathSigner } from '@commerceworker/ports';
import { gateFor } from './serve';

/** Short, so a replaced or unpublished asset reaches readers within a minute; no purge is needed. */
export const REDIRECT_MAX_AGE_SECONDS = 60;

/** An asset id as the catalog accepts it in `asset:<assetId>`. */
const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface AssetRefDeps {
  readonly paths: MediaPathSigner;
  /** The space and environment an `asset:` reference names its asset in: the deployment's own. */
  readonly scope: Scope;
  readonly gate?: AssetGate;
  readonly store?: Pick<ContentStore, 'assets'>;
  /** Milliseconds since the epoch; injected for tests. */
  readonly now?: () => number;
}

/**
 * The id and optional variant segment of `/a/<id>` or `/a/<id>/<variant>`, else `null`. A published
 * file's path has eight segments, so a space named `a` keeps its URLs.
 */
export function parseAssetRefPath(pathname: string): { id: string; variant?: string } | null {
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'a' || parts.length < 3 || parts.length > 4) return null;
  try {
    const id = decodeURIComponent(parts[2] ?? '');
    const variant = parts[3] === undefined ? undefined : decodeURIComponent(parts[3]);
    return variant === undefined ? { id } : { id, variant };
  } catch {
    return { id: '' };
  }
}

/** A 404 is cached briefly so a probe of unknown ids doesn't reach the replica every time. */
const NOT_FOUND_MAX_AGE_SECONDS = 30;

const plain = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': status === 404 ? `public, max-age=${NOT_FOUND_MAX_AGE_SECONDS}` : 'no-store',
    },
  });

/** Answers one reference request: 302 to the published URL, 400 for a bad variant, else 404. */
export async function serveAssetRef(
  url: URL,
  ref: { id: string; variant?: string },
  deps: AssetRefDeps,
): Promise<Response> {
  let variant: AssetVariant = ORIGINAL;
  if (ref.variant !== undefined) {
    const parsed = parseAssetVariant(ref.variant);
    if (!parsed) return plain(400, 'unknown variant');
    variant = parsed;
  }
  if (!ASSET_ID.test(ref.id)) return plain(404, 'not found');
  const gate = await gateFor(deps, { scope: deps.scope, assetId: ref.id });
  if (!gate) return plain(404, 'not found');
  // Never past the rights: a cached redirect must not outlive them.
  let maxAge = REDIRECT_MAX_AGE_SECONDS;
  if (gate.expiresAt) {
    const left = Math.floor((Date.parse(gate.expiresAt) - (deps.now?.() ?? Date.now())) / 1000);
    if (!(left > 0)) return plain(404, 'not found');
    maxAge = Math.min(maxAge, left);
  }
  // The same rule as the file itself: only a raster has variants.
  if (variant.kind !== 'original' && !isTransformableImage(gate.contentType)) {
    return plain(404, 'not found');
  }
  const path = assetMediaPath({
    scope: deps.scope,
    assetId: ref.id,
    version: gate.v,
    token: deps.paths.token(deps.scope, ref.id, gate.v),
    variant,
    fileName: gate.fileName,
  });
  // A width step asks for format negotiation, as every delivered URL of one does.
  const location = new URL(`${path}${variant.kind === 'width' ? '?fm=auto' : ''}`, url.origin);
  return new Response(null, {
    status: 302,
    // Nothing private varies it: the answer is the same for every reader.
    headers: { location: location.href, 'cache-control': `public, max-age=${maxAge}` },
  });
}
