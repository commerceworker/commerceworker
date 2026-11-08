import type { Scope } from '@commerceworker/domain';

// What the live route and LiveHubDO agree on, kept free of the Workers runtime so the route (and
// its tests) can use it without loading the Durable Object class.

/**
 * The header the live route sets on the request it forwards to LiveHubDO, carrying the authorized
 * scope and principal's grants. Only the route can reach the hub (it has no public route), and
 * the route always replaces whatever a caller sent.
 */
export const LIVE_ACCESS_HEADER = 'x-cw-live-access';

/**
 * The hub's object name for a scope, shared by the live route and the event bus. Each part is
 * percent-encoded, so the separator can't occur inside one: space `acme` + environment `eu:main`
 * and space `acme:eu` + environment `main` name different hubs.
 */
export const liveHubName = (scope: Scope) =>
  `${encodeURIComponent(scope.spaceId)}:${encodeURIComponent(scope.environmentId)}`;

/**
 * How long one stream lives. A subscriber's access is captured when it connects, so the stream
 * ends after this and the client reconnects, which authorizes it again: a revoked key or a
 * narrowed role stops receiving within this bound.
 */
export const LIVE_STREAM_MAX_MS = 10 * 60_000;
