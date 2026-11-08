import type { Scope } from '@commerceworker/domain';
import type { AppContext } from './context';
import { type DeliveryReads, deliveryReads } from './delivery-reads';

/**
 * Site routes: where each live content type's entries live on the site (`urlPattern`), so a
 * front end can route pages from the content model instead of hard-coding them. commerceworker
 * serves no site, so these are delivery data, like redirects.
 */

/** One content type's place on the site, as Delivery serves it. */
export interface DeliveredRoute {
  readonly contentType: string;
  /** `/blog/{slug}`: placeholders are `{id}`, `{locale}` or one of the type's Slug fields. */
  readonly urlPattern: string;
}

export interface RouteDeliveryOptions {
  /**
   * The content types the caller may read; the others' routes are left out, so a key limited to
   * some types never learns where the rest live. Default: all.
   */
  readonly readable?: (contentType: string) => boolean;
  readonly reads?: DeliveryReads;
}

/**
 * Every published content type with a URL pattern, by content type: as last published, so a live
 * type stays here, under the pattern a front end routes by, through a draft revision.
 */
export async function listDeliveredRoutes(
  ctx: AppContext,
  scope: Scope,
  opts: RouteDeliveryOptions = {},
): Promise<DeliveredRoute[]> {
  // Through the request's reads: a step that already loaded the content types costs nothing more.
  const { contentTypes = [] } = await (opts.reads ?? deliveryReads(ctx)).read(scope, {
    contentTypes: true,
  });
  const routes: DeliveredRoute[] = [];
  for (const t of contentTypes) {
    if (t.status !== 'published' || !t.urlPattern) continue;
    if (opts.readable && !opts.readable(t.apiId)) continue;
    routes.push({ contentType: t.apiId, urlPattern: t.urlPattern });
  }
  return routes.sort((a, b) =>
    a.contentType < b.contentType ? -1 : a.contentType > b.contentType ? 1 : 0,
  );
}
