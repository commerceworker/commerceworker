import { WorkerEntrypoint } from 'cloudflare:workers';
import { parseShareLinkPath } from '@commerceworker/domain';
import type { EdgeEnv } from '@commerceworker/platform/env';
import { publishedMediaAdapters } from '@commerceworker/platform/media';
import { wireMedia } from '@commerceworker/platform/wire';
import { type MediaDeps, serveMedia, serveMediaRange } from './serve';
import { type ShareDeps, serveSharePage } from './share';

type CachePurge = {
  purge(o: { tags: string[] }): Promise<{ success: boolean; errors: unknown[] }>;
};

/**
 * Media: the cached entrypoint. Workers Caching sits in front of it (wrangler `exports`), keyed by
 * the canonical URL the gateway builds. It is not routable from outside; only this Worker's gateway
 * calls it, with no client header at all.
 */
export class Media extends WorkerEntrypoint<EdgeEnv> {
  /** The ports the miss path reads, all read-only, from the composition root. */
  protected deps(): MediaDeps {
    if (!this.env.MEDIA_BUCKET) throw new Error('MEDIA_BUCKET is not bound');
    // Any replica: a gate miss tolerates replica lag, which the engine's second purge covers.
    const wired = wireMedia(this.env, { bookmark: 'first-unconstrained' });
    return {
      ...publishedMediaAdapters({
        bucket: this.env.MEDIA_BUCKET,
        ...(this.env.IMAGES ? { images: this.env.IMAGES } : {}),
      }),
      paths: wired.mediaPaths,
      ...(wired.assetGate ? { gate: wired.assetGate } : {}),
      ...(wired.store ? { store: wired.store } : {}),
    };
  }

  /** What a share page reads, read-only, from the composition root. */
  protected shareDeps(): ShareDeps {
    const wired = wireMedia(this.env, { bookmark: 'first-unconstrained' });
    return {
      paths: wired.mediaPaths,
      passwords: wired.passwords,
      ...(wired.store ? { store: wired.store } : {}),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    // A share link's page: rendered here so Workers Caching keeps it (tagged per link).
    if (parseShareLinkPath(new URL(request.url).pathname)) {
      return serveSharePage(request, this.shareDeps());
    }
    return serveMedia(request, this.deps());
  }

  /**
   * One byte range of a canonical URL, read from R2 by range. RPC, not `fetch`: Workers Caching
   * never sees it, so the partial is never stored. The gateway calls it only when the cached
   * `fetch` answered a range request with the whole file (nothing sliced it).
   */
  async range(url: string, range: string, ifRange: string | null): Promise<Response> {
    return serveMediaRange(new Request(url), this.deps(), range, ifRange);
  }

  /** Purges cached responses by tag. Workers Caching scopes a purge to the entrypoint calling it. */
  async purge(tags: string[]): Promise<{ success: boolean; skipped?: true }> {
    const cache = (this.ctx as unknown as { cache?: CachePurge }).cache;
    // Local dev and tests have no Workers Caching.
    if (!cache) return { success: true, skipped: true };
    const r = await cache.purge({ tags });
    if (!r.success) console.error('media purge refused', JSON.stringify(r.errors));
    return { success: r.success };
  }
}
