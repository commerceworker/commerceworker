import { WorkerEntrypoint } from 'cloudflare:workers';
import { createHasher, resolveEnvironment } from '@commerceworker/application';
import { NotFoundError, type Principal } from '@commerceworker/domain';
import type { AuthDeps } from '@commerceworker/http/api/auth';
import { toHttpError } from '@commerceworker/http/api/http';
import { deliveryApp, deliveryRoutes } from '@commerceworker/http/api/routes/delivery';
import type { EdgeEnv } from '@commerceworker/platform/env';
import { deliveryScopeTag } from '@commerceworker/platform/messages';
import { wireEdge } from '@commerceworker/platform/wire';
import { hasGraphqlErrors } from './client-cache';
import { fromCanonical } from './profile';

/** Header the gateway uses to hand the authenticated principal to this entrypoint. */
export const PRINCIPAL_HEADER = 'x-cw-delivery-principal';

/**
 * Fresh for a minute, then served stale while revalidating for a day. Staleness is bounded by
 * purges: every publish in a space:environment purges its tag (the purge queue). Authorization is
 * never stale: the gateway authenticates every request before the cache.
 */
export const FRESH = 'public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800';
const NO_STORE = 'private, no-store';

type CachePurge = {
  purge(o: { tags: string[] }): Promise<{ success: boolean; errors: unknown[] }>;
};

/**
 * Delivery: the cached entrypoint. Workers Caching sits in front of it (wrangler `exports`), keyed
 * by the canonical URL the gateway builds: `/_p/<profile>/delivery/<space>/<env>/...` with sorted
 * query parameters. It is not routable from outside; only the gateway in this Worker calls it,
 * with the principal it already authenticated.
 *
 * On a miss it serves the read through the same delivery routes the api Worker mounts, against a
 * D1 read-replica session (`first-unconstrained`: delivery tolerates replica lag, and is
 * eventually consistent with publishes by design), so the hot path never reaches the primary.
 */
export class Delivery extends WorkerEntrypoint<EdgeEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parsed = fromCanonical(url);
    const raw = request.headers.get(PRINCIPAL_HEADER);
    if (!parsed || !raw) return new Response('not found', { status: 404 });
    const principal = JSON.parse(raw) as Principal;

    const wired = wireEdge(this.env, { bookmark: 'first-unconstrained' });
    const deps: AuthDeps = {
      ctx: wired.ctx,
      hasher: createHasher(wired.config.tokenPepper),
      // Delivery serves API keys only: no admin token, ever (not even a configured one).
      adminToken: '',
      rag: wired.rag,
      assetSearch: wired.assetSearch,
      blob: wired.blob,
      ai: wired.ai,
      bus: wired.bus,
      importSources: wired.importSources,
      spaceExportReader: wired.spaceExportReader,
      remoteFetcher: wired.remoteFetcher,
      agents: wired.inProcessAgents({ ctx: wired.ctx, ai: wired.ai }),
      rateLimiter: wired.authRateLimit,
      trustedPrincipal: () => principal,
    };
    const app = deliveryApp(deliveryRoutes(deps));
    const res = await app.fetch(new Request(parsed.path.toString(), { method: 'GET' }));

    const m = /^\/delivery\/([^/]+)\/([^/]+)\//.exec(parsed.path.pathname);
    const headers = new Headers(res.headers);
    // 200s, and the deprecated transform's 301 to an immutable media URL, are kept and purged
    // like any read.
    if ((res.status === 200 || res.status === 301) && m) {
      const body = await res.arrayBuffer();
      // A GraphQL answer carrying errors is still a 200 (GraphQL over HTTP), but it must not be
      // kept: the cause (a field rule, a bug) can change without any publish to purge it.
      if (
        res.status === 200 &&
        parsed.path.pathname.endsWith('/graphql') &&
        hasGraphqlErrors(body)
      ) {
        headers.set('cache-control', NO_STORE);
        return new Response(body, { status: 200, headers });
      }
      const etag = await bodyEtag(body);
      headers.set('etag', etag);
      headers.set('cache-control', FRESH);
      // Tagged with the path's environment and the one it resolves to, so a publish (which
      // purges the concrete environment) and an alias repoint (which purges the alias) both
      // reach responses served under an alias.
      const space = decodeURIComponent(m[1] as string);
      const named = decodeURIComponent(m[2] as string);
      let concrete: string;
      try {
        concrete = await resolveEnvironment(wired.ctx, space, named);
      } catch (err) {
        // Deleted between the read and this lookup: answer as the read would now, uncached.
        if (!(err instanceof NotFoundError)) throw err;
        const { status, body: errorBody } = toHttpError(err);
        headers.set('cache-control', NO_STORE);
        headers.set('content-type', 'application/json');
        return new Response(JSON.stringify(errorBody), { status, headers });
      }
      headers.set(
        'cache-tag',
        [...new Set([deliveryScopeTag(space, named), deliveryScopeTag(space, concrete)])].join(','),
      );
      // Always the full body: this response is what Workers Caching stores, so a 304 here would
      // be cached as an empty answer. Conditional requests are answered by the gateway.
      return new Response(body, { status: res.status, headers });
    }
    // Errors and empty answers are not cached: a 404 for an entry about to be published must not
    // outlive the publish.
    headers.set('cache-control', NO_STORE);
    return new Response(res.body, { status: res.status, headers });
  }

  /** Purges cached responses by tag. Workers Caching scopes a purge to the entrypoint calling it. */
  async purge(tags: string[]): Promise<{ success: boolean; skipped?: true }> {
    const cache = (this.ctx as unknown as { cache?: CachePurge }).cache;
    // Local dev and tests have no Workers Caching.
    if (!cache) return { success: true, skipped: true };
    const r = await cache.purge({ tags });
    if (!r.success) console.error('purge refused', JSON.stringify(r.errors));
    return { success: r.success };
  }
}

/** A strong ETag over the response bytes. */
export async function bodyEtag(body: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  return `"${[...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
}

/** Whether an If-None-Match header names `etag` (weak or strong, or `*`). */
export function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === etag);
}
