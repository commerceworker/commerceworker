/**
 * The UCP port (`UcpStore`, @commerceworker/ports/commerce) on D1: `ucp_idempotency` and
 * `ucp_platforms`. Moved here from the engine's agentic checkout. The contract in
 * @commerceworker/test-kit/commerce holds this and the in-memory store to the same behaviour.
 */
import type { UcpStore } from '@commerceworker/ports/commerce';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { createDb } from './index';
import { ucpIdempotency, ucpPlatforms } from './schema';

/** A platform as the admin API shows it: never its key. */
const view = {
  id: ucpPlatforms.id,
  name: ucpPlatforms.name,
  profileUrl: ucpPlatforms.profileUrl,
  keyPrefix: ucpPlatforms.keyPrefix,
  createdAt: ucpPlatforms.createdAt,
  createdBy: ucpPlatforms.createdBy,
  lastUsedAt: ucpPlatforms.lastUsedAt,
  revokedAt: ucpPlatforms.revokedAt,
};

export function d1UcpStore(d1: D1Database): UcpStore {
  const d = createDb(d1);
  const keyed = (ownerId: string, key: string) =>
    and(eq(ucpIdempotency.ownerId, ownerId), eq(ucpIdempotency.key, key));
  return {
    async claimKey(ownerId, key, requestHash, now, staleBefore) {
      // A key older than the TTL is free again.
      await d
        .delete(ucpIdempotency)
        .where(and(keyed(ownerId, key), lt(ucpIdempotency.createdAt, staleBefore)));
      const res = await d
        .insert(ucpIdempotency)
        .values({ ownerId, key, requestHash, createdAt: now })
        .onConflictDoNothing()
        .returning({ key: ucpIdempotency.key });
      return res.length > 0;
    },

    heldKey: (ownerId, key) =>
      d
        .select({
          requestHash: ucpIdempotency.requestHash,
          status: ucpIdempotency.status,
          response: ucpIdempotency.response,
        })
        .from(ucpIdempotency)
        .where(keyed(ownerId, key))
        .get(),

    async settleKey(ownerId, key, status, response) {
      await d.update(ucpIdempotency).set({ status, response }).where(keyed(ownerId, key));
    },

    async releaseKey(ownerId, key) {
      await d.delete(ucpIdempotency).where(keyed(ownerId, key));
    },

    platforms: (limit) =>
      d.select(view).from(ucpPlatforms).orderBy(desc(ucpPlatforms.createdAt)).limit(limit),
    async addPlatform(p) {
      await d.insert(ucpPlatforms).values(p);
    },
    async revokePlatform(id, at) {
      const [gone] = await d
        .update(ucpPlatforms)
        .set({ revokedAt: at })
        .where(and(eq(ucpPlatforms.id, id), isNull(ucpPlatforms.revokedAt)))
        .returning(view);
      return gone;
    },
    livePlatform: (keyHash) =>
      d
        .select(view)
        .from(ucpPlatforms)
        .where(and(eq(ucpPlatforms.keyHash, keyHash), isNull(ucpPlatforms.revokedAt)))
        .get(),
    async touchPlatform(id, at) {
      await d.update(ucpPlatforms).set({ lastUsedAt: at }).where(eq(ucpPlatforms.id, id));
    },
    platform: (id) =>
      d
        .select({
          profile: ucpPlatforms.profile,
          profileFetchedAt: ucpPlatforms.profileFetchedAt,
          revokedAt: ucpPlatforms.revokedAt,
        })
        .from(ucpPlatforms)
        .where(eq(ucpPlatforms.id, id))
        .get(),

    async cacheProfile(id, profile, at) {
      await d
        .update(ucpPlatforms)
        .set({ profile, profileFetchedAt: at })
        .where(eq(ucpPlatforms.id, id));
    },
  };
}
