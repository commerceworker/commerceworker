import {
  deliveredLocaleConfig,
  isLocaleDelivered,
  type LocaleConfig,
  NotFoundError,
  type Scope,
} from '@commerceworker/domain';
import type { DeliveryReadRequest, DeliveryReadResult } from '@commerceworker/ports';
import type { AppContext } from './context';

/**
 * One Delivery request's reads. Each `read` is one store call (one D1 round trip, however many
 * statements), and the parts every step of a request asks for again (the space config, the
 * content types, the rendition presets) are read once and remembered for the rest of it: a
 * GraphQL request that loaded them to build its schema doesn't load them again per field.
 *
 * Make one per request and drop it with the request: nothing here expires, so it must never be
 * held across requests (a long-lived one would serve a stale config). Remembered parts are keyed
 * by scope, so one request reading two scopes never mixes their answers. Entries and assets are
 * never remembered: each read asks for its own.
 */
export interface DeliveryReads {
  read(scope: Scope, request: DeliveryReadRequest): Promise<DeliveryReadResult>;
  /** Preview's reads (`previewReads`): the config keeps every locale, delivered or not. */
  readonly everyLocale?: boolean;
}

/** The parts read once per request. */
const REMEMBERED = ['config', 'contentTypes', 'renditions'] as const;
type Remembered = (typeof REMEMBERED)[number];

const asksForAnything = (request: DeliveryReadRequest): boolean =>
  Object.values(request).some((v) => v !== undefined && v !== false);

/**
 * The same reads for Preview, which serves what editors write: every locale, delivered or not
 * (the space config as stored).
 */
export const previewReads = (ctx: Pick<AppContext, 'store'>): DeliveryReads =>
  deliveryReads(ctx, { everyLocale: true });

export function deliveryReads(
  ctx: Pick<AppContext, 'store'>,
  opts: { readonly everyLocale?: boolean } = {},
): DeliveryReads {
  // In flight or settled, so two fields resolving at once share one read.
  const remembered = new Map<string, Promise<unknown>>();
  const keyOf = (part: Remembered, scope: Scope) =>
    `${part}\u0000${scope.spaceId}\u0000${scope.environmentId}`;

  return {
    ...(opts.everyLocale ? { everyLocale: true } : {}),
    async read(scope, request) {
      const ask: { -readonly [K in keyof DeliveryReadRequest]: DeliveryReadRequest[K] } = {
        ...request,
      };
      const known = new Map<Remembered, Promise<unknown>>();
      for (const part of REMEMBERED) {
        const hit = request[part] ? remembered.get(keyOf(part, scope)) : undefined;
        if (hit) {
          known.set(part, hit);
          delete ask[part];
        }
      }
      // The space as Delivery sees it: its undelivered locales gone from `locales` and skipped by
      // every fallback, so nothing downstream (renders, sitemap alternates, menus, labels) can
      // reach their values.
      const fresh = (
        asksForAnything(ask) ? ctx.store.delivery.read(scope, ask) : Promise.resolve({})
      ).then((r: DeliveryReadResult) =>
        r.config && !opts.everyLocale ? { ...r, config: deliveredLocaleConfig(r.config) } : r,
      );
      for (const part of REMEMBERED) {
        if (!ask[part]) continue;
        const key = keyOf(part, scope);
        const value = fresh.then((r) => r[part]);
        remembered.set(key, value);
        // A failed read isn't an answer: the next step asks again.
        value.catch(() => {
          if (remembered.get(key) === value) remembered.delete(key);
        });
      }
      const result: { -readonly [K in keyof DeliveryReadResult]: unknown } = { ...(await fresh) };
      for (const [part, value] of known) result[part] = await value;
      return result as DeliveryReadResult;
    },
  };
}

/**
 * Refuses a Delivery read that names a locale the space doesn't deliver: 404, as for anything
 * else Delivery doesn't serve. A locale the space doesn't have at all is not refused (it resolves
 * through the default locale, as it always has); only one an editor turned off is, so a front end
 * leaves its route out rather than serving another language's content under it.
 */
export function assertDeliveredLocale(config: LocaleConfig, locale: string | undefined): void {
  if (locale && !isLocaleDelivered(config, locale)) throw new NotFoundError('Locale', locale);
}
