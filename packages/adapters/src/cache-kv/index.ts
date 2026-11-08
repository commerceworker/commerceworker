import type { Cache } from '@commerceworker/ports';

/** The subset of a Workers KV namespace binding this adapter uses. */
export interface KvBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface CachedEnvelope {
  readonly value: string;
  /** Tag versions captured at write time; any drift means the entry is stale. */
  readonly tags: { tag: string; ver: string }[];
}

const valueKey = (key: string) => `c:${key}`;
const tagKey = (tag: string) => `tv:${tag}`;

/** Workers KV enforces a 60-second minimum expiration TTL. */
const MIN_KV_TTL_SECONDS = 60;

/**
 * Lifetime of `tv:` tag-version keys — 2× the longest envelope TTL the
 * platform writes (1 day), so no live envelope can outlast the versions it
 * snapshotted. If a tag key ever expires early, its version reads as the
 * default `'0'`, which mismatches any snapshotted uuid — expiry can only
 * produce a miss, never a stale hit.
 */
const TAG_VERSION_TTL_SECONDS = 172_800;

/**
 * Workers KV Cache with tag-based invalidation via tag-version keys:
 * `invalidateTag` writes a new version under `tv:<tag>`; `set` snapshots the
 * current versions of its tags into the envelope; `get` re-reads them and
 * treats any mismatch as a miss (lazy eviction).
 *
 * Consistency note: KV propagates writes to remote points of presence
 * eventually (worst case ~60s for a hot key), so a just-published entry may be
 * served stale elsewhere for up to that window — CDN-class semantics, applied
 * only to the Delivery API. Strict-freshness deployments run uncached.
 */
export function createKvCache(kv: KvBinding): Cache {
  const readVersions = (tags: readonly string[]) =>
    Promise.all(tags.map(async (tag) => ({ tag, ver: (await kv.get(tagKey(tag))) ?? '0' })));

  return {
    async get(key) {
      const raw = await kv.get(valueKey(key));
      if (raw === null) return null;
      let envelope: CachedEnvelope;
      try {
        envelope = JSON.parse(raw) as CachedEnvelope;
      } catch {
        return null;
      }
      if (envelope.tags.length > 0) {
        const current = await readVersions(envelope.tags.map((t) => t.tag));
        const fresh = envelope.tags.every((t, i) => current[i]?.ver === t.ver);
        if (!fresh) return null;
      }
      return envelope.value;
    },

    async set(key, value, opts) {
      const tags = await readVersions(opts?.tags ?? []);
      const envelope: CachedEnvelope = { value, tags };
      // Clamp the envelope TTL to half the tag-version TTL: an envelope must
      // never outlive the tag versions it snapshotted, or an expired tag key
      // reading as the default '0' could MATCH an envelope that snapshotted
      // '0' before any invalidation — a stale hit, not a miss.
      const ttl = opts?.ttlSeconds
        ? Math.min(Math.max(MIN_KV_TTL_SECONDS, opts.ttlSeconds), TAG_VERSION_TTL_SECONDS / 2)
        : undefined;
      await kv.put(valueKey(key), JSON.stringify(envelope), {
        ...(ttl ? { expirationTtl: ttl } : {}),
      });
    },

    async invalidateTag(tag) {
      await kv.put(tagKey(tag), crypto.randomUUID(), { expirationTtl: TAG_VERSION_TTL_SECONDS });
    },

    async invalidateTags(tags) {
      // Dedupe is the win here (KV has no batched write): a bulk batch's
      // overlapping closures collapse to one version bump per distinct tag.
      await Promise.all(
        [...new Set(tags)].map((tag) =>
          kv.put(tagKey(tag), crypto.randomUUID(), { expirationTtl: TAG_VERSION_TTL_SECONDS }),
        ),
      );
    },
  };
}
