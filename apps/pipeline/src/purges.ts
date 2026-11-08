/**
 * What a batch of events leaves stale at the edge, and the purge messages that say so. Workers
 * Caching is per Worker, so delivery and media each drain their own queue: delivery responses are
 * tagged by space:environment, media responses by asset, rendition and environment.
 */
import type { AppContext } from '@commerceworker/application';
import type { DomainEvent } from '@commerceworker/domain';
import {
  deliveryScopeTag,
  mediaAssetTag,
  mediaCollectionTag,
  mediaEnvironmentTag,
  mediaRenditionTag,
  mediaShareLinkTag,
  type PurgeMessage,
} from '@commerceworker/platform/messages';

/** Events after which a space:environment's delivery responses may be stale. */
export const PURGING_EVENTS = new Set<string>([
  // Besides the entries themselves, the sitemap (`GET …/sitemap`, `…/sitemap.xml`) lists the
  // published entries and their SEO: a publish or unpublish purges it with them.
  'entry.published',
  'entry.unpublished',
  'entries.published_bulk',
  'asset.published',
  'asset.unpublished',
  'asset.deleted',
  'asset.rights_changed',
  // Delivery lists a collection's published members (`GET …/collections/:id`), cached under the
  // scope's tag like every other delivery read: one tag, coalesced per batch.
  'asset_collection.changed',
  // Delivery serves tags and concepts (labels, slugs, counts) under the scope's tag too.
  'taxonomy.changed',
  // Delivery serves the enabled set (`GET …/redirects`) and each path's match from it.
  'redirects.changed',
  // Delivery serves menus (`GET …/menus/:handle`) resolved against published entries: a menu's
  // own change says so here, and a publish or unpublish that changes what it resolves to already
  // purges through the entry events above.
  'menus.changed',
  // Delivery serves each published type's URL pattern (`GET …/routes`), builds GraphQL from it,
  // and lists the type's entries in the sitemap by it.
  'content_type.published',
  // A deleted type leaves GraphQL, the routes and the sitemap.
  'content_type.deleted',
  'release.published',
  'environment_alias.changed',
  'environment.deleted',
]);

/**
 * Seconds before a revoked asset's media is purged a second time. A colo may still read the gate
 * entry it cached (KV's 60 s read cache) or a lagging D1 replica just after the first purge, and
 * cache the bytes again; by now every colo sees the removal, so the second purge is the last.
 */
export const REVOCATION_REPURGE_SECONDS = 90;

export interface PurgePlan {
  readonly delivery: Set<string>;
  /** Purged now. */
  readonly media: Set<string>;
  /** Purged now and again after {@link REVOCATION_REPURGE_SECONDS}: what stopped being served. */
  readonly revoked: Set<string>;
}

export const newPurgePlan = (): PurgePlan => ({
  delivery: new Set(),
  media: new Set(),
  revoked: new Set(),
});

/**
 * Most collections an asset event purges the share pages of. Past it, a share page of a collection
 * holding the asset shows it (or not) until the page's own max-age (at most an hour) runs out.
 */
export const MAX_COLLECTIONS_PURGED = 100;

/** Adds what `event` makes stale to `plan`. */
export async function planPurges(
  ctx: Pick<AppContext, 'store'>,
  plan: PurgePlan,
  event: DomainEvent,
): Promise<void> {
  const { spaceId, environmentId } = event.scope;
  if (PURGING_EVENTS.has(event.type)) {
    plan.delivery.add(deliveryScopeTag(spaceId, environmentId));
  }
  // Ingest changes what Delivery serves (its search, the measured dimensions) only for a published
  // asset; a draft's ingest leaves every delivery response as it was.
  if (event.type === 'asset.ingested' && event.published) {
    plan.delivery.add(deliveryScopeTag(spaceId, environmentId));
  }
  // A move changes the manual order Delivery serves (`order=sys.position`) only for a published
  // entry: a draft's place is in no delivery response yet.
  if (event.type === 'entry.moved' && event.published) {
    plan.delivery.add(deliveryScopeTag(spaceId, environmentId));
  }
  // A share page of a collection lists its members' published files: a member published or
  // unpublished makes every such page stale. (A deleted asset has left its collections by now;
  // its delete announced each one with `asset_collection.changed`.)
  if (
    event.type === 'asset.published' ||
    event.type === 'asset.unpublished' ||
    event.type === 'asset.rights_changed'
  ) {
    const collections = await ctx.store.assetCollections.collectionsOf(
      event.scope,
      event.assetId,
      MAX_COLLECTIONS_PURGED,
    );
    // An asset leaving Delivery leaves its collections' pages too: purged as a revocation is (now,
    // and again once a lagging replica can no longer render it back in). A publish only adds.
    const into = event.type === 'asset.published' ? plan.media : plan.revoked;
    for (const id of collections) into.add(mediaCollectionTag(spaceId, environmentId, id));
  }
  switch (event.type) {
    case 'asset_collection.changed':
      // A member removed must not come back from a lagging replica: purged twice.
      plan.revoked.add(mediaCollectionTag(spaceId, environmentId, event.collectionId));
      break;
    case 'asset_share.revoked':
      // Its page and the files under it stop at the gateway at once (it checks the link on every
      // request); the cached page goes too, now and once every colo's KV read has expired.
      plan.revoked.add(mediaShareLinkTag(spaceId, environmentId, event.linkId));
      break;
    case 'asset.published':
      // A republish with a new file takes the old version out of Delivery: its URLs must stop
      // working, so they are purged as a revocation is (now, and again once every colo sees the
      // new gate). Otherwise a republish can still move the focal point (so a crop) under the
      // same URL.
      if (event.replacedVersion !== undefined) {
        plan.revoked.add(mediaAssetTag(spaceId, environmentId, event.assetId));
      } else {
        plan.media.add(mediaAssetTag(spaceId, environmentId, event.assetId));
      }
      break;
    case 'asset.unpublished':
    case 'asset.deleted':
    // New rights change how long a cached file may be kept (an expiry caps it), and an immutable
    // response cached before must not outlive them: purged as a revocation is.
    case 'asset.rights_changed':
      plan.revoked.add(mediaAssetTag(spaceId, environmentId, event.assetId));
      break;
    case 'asset_renditions.changed': {
      // Presets belong to the space: every environment lists them, and every environment's
      // images were made with them.
      plan.revoked.add(mediaRenditionTag(spaceId, event.name));
      for (const env of await ctx.store.spaces.listEnvironments(spaceId)) {
        plan.delivery.add(deliveryScopeTag(spaceId, env.id));
      }
      break;
    }
    case 'space_locales.changed':
      // Locale settings belong to the space: what every environment delivers changes with them
      // (a locale turned off is no longer served, nor reached by a fallback, nor in the sitemap).
      for (const env of await ctx.store.spaces.listEnvironments(spaceId)) {
        plan.delivery.add(deliveryScopeTag(spaceId, env.id));
      }
      break;
    case 'environment.deleted':
    // Each purge step too: the last one clears the gate again (an entry written back while the
    // rows were still there), so the environment's cached media is purged after it, now and once
    // more after the delay. Cheap: one tag, coalesced per batch.
    case 'environment.purge_due':
      plan.revoked.add(mediaEnvironmentTag(spaceId, environmentId));
      break;
    default:
      break;
  }
}

/** Most tags one media purge message carries (well under a queue message's 128 KB). */
export const MEDIA_TAGS_PER_MESSAGE = 100;

const chunks = (tags: readonly string[]): string[][] => {
  const out: string[][] = [];
  for (let at = 0; at < tags.length; at += MEDIA_TAGS_PER_MESSAGE) {
    out.push(tags.slice(at, at + MEDIA_TAGS_PER_MESSAGE));
  }
  return out;
};

/** The producers the plan goes to; either may be unbound (that cache then ages out alone). */
export interface PurgeQueues {
  readonly PURGE_QUEUE?: Pick<Queue, 'send'>;
  readonly MEDIA_PURGE_QUEUE?: Pick<Queue, 'send'>;
}

/**
 * Sends the plan: one delivery message, one media message for everything stale now, and a delayed
 * one for what was revoked. A failed send is logged, not thrown: the events it came from are
 * already handled, and retrying them would re-run every effect for a cache that ages out anyway.
 */
export async function sendPurges(
  queues: PurgeQueues,
  plan: PurgePlan,
  onError: (what: string, err: unknown) => void,
): Promise<void> {
  const sends: Promise<unknown>[] = [];
  if (plan.delivery.size > 0 && queues.PURGE_QUEUE) {
    const message: PurgeMessage = { tags: [...plan.delivery] };
    sends.push(
      queues.PURGE_QUEUE.send(message).catch((err: unknown) => onError('delivery purge', err)),
    );
  }
  // Revoked tags first, in messages of MEDIA_TAGS_PER_MESSAGE: a batch that touched many
  // collections can't make one message too large to send and lose the revocations with it.
  const media = [...new Set([...plan.revoked, ...plan.media])];
  const queue = queues.MEDIA_PURGE_QUEUE;
  if (media.length > 0 && queue) {
    for (const tags of chunks(media)) {
      const now: PurgeMessage = { tags };
      sends.push(queue.send(now).catch((err: unknown) => onError('media purge', err)));
    }
    for (const tags of chunks([...plan.revoked])) {
      const again: PurgeMessage = { tags };
      sends.push(
        queue
          .send(again, { delaySeconds: REVOCATION_REPURGE_SECONDS })
          .catch((err: unknown) => onError('media re-purge', err)),
      );
    }
  }
  await Promise.all(sends);
}
