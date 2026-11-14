/**
 * The media Worker: published asset files at `media.<domain>`, cached at the edge.
 *
 * This default entrypoint is the gateway, with no cache in front of it. It trusts no request
 * header: it reads `Accept` only to pick an output format, `If-None-Match` only to answer 304, and
 * `Range` (one `bytes=` range) and `If-Range` only to pass them to the cache, which slices ranges
 * out of the whole file it stores. `?download` asks for `Content-Disposition: attachment` (the
 * default is `inline`); like every other query parameter it never reaches the cache key.
 * Per request it either
 * 1. checks a public URL's token (`/<space>/<env>/<asset>/v<n>/<token>/<variant>/<file>`), maps
 *    it to its canonical form (the path, and for a variant the negotiated format) and asks the
 *    cached `Media` entrypoint, which checks the engine's gate on a miss; or
 * 2. serves a short-lived signed read (`/media/<key>?exp=…&sig=…`, Preview's drafts), uncached,
 *    when the signature and expiry hold. Never an upload, never a URL without
 *    an expiry; or
 * 3. answers an asset reference (`/a/<assetId>[/<variant>]`, what a product's `asset:<assetId>`
 *    publishes as) with a 302 to the asset's current published URL (asset-ref.ts); or
 * 4. serves a share link (`/s/<space>/<env>/<link>/<token>…`: its page, its files, its password
 *    form), checking the link on every request (share.ts).
 *
 * Its queue consumer drains `commerceworker-media-purge`, rationed like delivery's.
 */

import { parseShareLinkPath } from '@commerceworker/domain';
import { recordDeadLetters } from '@commerceworker/platform/dead-letters';
import { type EdgeEnv, queueName } from '@commerceworker/platform/env';
import { mediaAdapters } from '@commerceworker/platform/media';
import type { PurgeMessage } from '@commerceworker/platform/messages';
import { drain } from '@commerceworker/platform/purge';
import { wireMedia } from '@commerceworker/platform/wire';
import { parseAssetRefPath, serveAssetRef } from './asset-ref';
import type { Media } from './media';
import { canonicalMediaUrl, contentDisposition, singleByteRange } from './serve';
import { handleShareRequest } from './share';

export { Media } from './media';

type Exports = { Media: Service<Media> };

const PUBLIC = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers':
    'etag, cf-cache-status, accept-ranges, content-range, content-length, content-disposition',
  'timing-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000',
};

function withPublic(res: Response, extra: Record<string, string> = {}): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...PUBLIC, ...extra })) out.headers.set(k, v);
  return out;
}

/** Whether an If-None-Match header names `etag` (weak or strong, or `*`). */
function matches(ifNoneMatch: string | null, etag: string | null): boolean {
  if (!ifNoneMatch || !etag) return false;
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === etag);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health')
      return Response.json({ ok: true, service: 'commerceworker-media' });
    // A share link: its page, one of its files, or (the only POST anywhere here) its password.
    // Verified, then the link read, before anything else (share.ts).
    // Only a path of a share link's shape: a space named `s` keeps its published URLs (8 segments,
    // which no share path has).
    if (parseShareLinkPath(url.pathname)) {
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
        return withPublic(new Response('method not allowed', { status: 405 }), {
          allow: 'GET, HEAD, POST',
        });
      }
      const wired = wireMedia(env);
      const exports = (ctx as unknown as { exports: Exports }).exports;
      const res = await handleShareRequest(
        request,
        {
          paths: wired.mediaPaths,
          passwords: wired.passwords,
          ...(wired.store ? { store: wired.store } : {}),
          ...(env.RATE_LIMIT_SHARE_UNLOCK ? { limiter: env.RATE_LIMIT_SHARE_UNLOCK } : {}),
        },
        {
          fetch: (req) => exports.Media.fetch(req),
          range: (u, r, i) => exports.Media.range(u, r, i),
        },
      );
      // A share page is for the people it was given to: no cross-origin reads of it.
      if (res.headers.get('content-type')?.startsWith('text/html')) return res;
      return withPublic(res);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return withPublic(new Response('read only', { status: 405 }), { allow: 'GET, HEAD' });
    }

    const wired = wireMedia(env);
    if (url.pathname.startsWith('/media/')) {
      if (!env.MEDIA_BUCKET) return withPublic(new Response('not found', { status: 404 }));
      const transfer = mediaAdapters({
        bucket: env.MEDIA_BUCKET,
        signer: wired.mediaSigner,
        requireExpiry: true,
        readOnly: true,
        ...(env.IMAGES ? { images: env.IMAGES } : {}),
      }).transfer;
      const res = (await transfer?.(request)) ?? new Response('not found', { status: 404 });
      return withPublic(res);
    }

    const ref = parseAssetRefPath(url.pathname);
    if (ref) {
      const res = await serveAssetRef(url, ref, {
        paths: wired.mediaPaths,
        // The deployment's one media scope (registry `mediaScope`, rendered by the fleet).
        scope: {
          spaceId: env.ASSET_REF_SPACE || 'space-1',
          environmentId: env.ASSET_REF_ENV || 'main',
        },
        ...(wired.assetGate ? { gate: wired.assetGate } : {}),
        ...(wired.store ? { store: wired.store } : {}),
      });
      return withPublic(res);
    }

    const canonical = canonicalMediaUrl(url, request.headers.get('accept'), wired.mediaPaths);
    if (!canonical) {
      return withPublic(new Response('not found', { status: 404 }), {
        'cache-control': 'no-store',
      });
    }
    const exports = (ctx as unknown as { exports: Exports }).exports;
    // A fresh request: nothing the client sent reaches the cache or its key, but one byte range
    // (and its If-Range), which Workers Caching answers from the whole file it stores. Several
    // ranges are served whole.
    const range = singleByteRange(request.headers.get('range'));
    const ifRange = range ? request.headers.get('if-range') : null;
    const forwarded = new Headers();
    if (range) forwarded.set('range', range);
    if (ifRange) forwarded.set('if-range', ifRange);
    let upstream = await exports.Media.fetch(new Request(canonical.url, { headers: forwarded }));
    const etag = upstream.headers.get('etag');
    const extra: Record<string, string> = canonical.negotiated ? { vary: 'Accept' } : {};
    if (
      (upstream.status === 200 || upstream.status === 206) &&
      matches(request.headers.get('if-none-match'), etag)
    ) {
      await upstream.body?.cancel();
      return withPublic(new Response(null, { status: 304, headers: upstream.headers }), extra);
    }
    if (
      range &&
      upstream.status === 200 &&
      canonical.address.variant.kind === 'original' &&
      (ifRange === null || ifRange.trim() === etag)
    ) {
      // Nothing sliced it (no cache in front, or a file the cache didn't keep): R2 reads the
      // range itself, over RPC, which the cache never stores. A variant is served whole.
      await upstream.body?.cancel();
      upstream = await exports.Media.range(canonical.url, range, ifRange);
    }
    if (upstream.status === 200 || upstream.status === 206) {
      // Inline unless asked for a download, or unless the type may never render here (an SVG or
      // HTML upload, which the cached response already marks as an attachment).
      const download =
        url.searchParams.has('download') ||
        upstream.headers.get('content-disposition')?.startsWith('attachment');
      extra['content-disposition'] = contentDisposition(
        download ? 'attachment' : 'inline',
        canonical.address.fileName,
      );
    }
    if (request.method === 'HEAD') {
      await upstream.body?.cancel();
      return withPublic(new Response(null, upstream), extra);
    }
    return withPublic(upstream, extra);
  },

  async queue(batch, env, ctx) {
    if (batch.queue === queueName(env, 'commerceworker-media-purge-dlq')) {
      // Purges that failed every retry: the media they name stays cached (it is immutable), so
      // keep a record; an operator can purge its tags by hand.
      await recordDeadLetters(batch, env.MEDIA_BUCKET, () =>
        env.METRICS?.writeDataPoint({
          blobs: ['commerceworker_media_purge_dead_letters_total'],
          doubles: [1],
        }),
      );
      return;
    }
    const exports = (ctx as unknown as { exports: Exports }).exports;
    await drain(batch as MessageBatch<PurgeMessage>, (tags) => exports.Media.purge(tags));
  },
} satisfies ExportedHandler<EdgeEnv>;
