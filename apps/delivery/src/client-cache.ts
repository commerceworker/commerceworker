/**
 * What clients may do with a delivery response. Workers Caching keeps its own (public) policy for
 * the cached entrypoint; to clients a successful response is private, because it was authorized
 * for this key and no shared cache downstream may reuse it for another caller. Anything else (a
 * 404 for an entry about to be published, a 401, an error) must not be kept at all.
 */
export const CLIENT_CACHE = 'private, max-age=60, must-revalidate';

export function clientCacheControl(status: number, upstream?: string | null): string {
  // The cached entrypoint marks what must not be kept even when it succeeded (a GraphQL answer
  // with errors): never upgrade that to a cacheable policy.
  if (upstream?.includes('no-store')) return 'no-store';
  // A 301 is the deprecated transform's redirect to an immutable media URL: kept like a read.
  return status === 200 || status === 304 || status === 301 ? CLIENT_CACHE : 'no-store';
}

/** Whether a GraphQL response body reports errors. */
export function hasGraphqlErrors(body: ArrayBuffer): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { errors?: unknown[] };
    return Array.isArray(parsed.errors) && parsed.errors.length > 0;
  } catch {
    return true;
  }
}
