import type { AuditAnchors } from '@commerceworker/ports/commerce';

type Anchor = Parameters<AuditAnchors['write']>[0];

/** The subset of an R2 bucket binding the anchors use; a binding fits as is. */
export interface R2AnchorBucketLike {
  put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: { contentType?: string };
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(options: { prefix?: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/** The key layout is a core rule (`auditAnchorKey`), handed in with how far back `latest` looks. */
export interface R2AnchorLayout {
  keyOf(at: number): string;
  lookbackDays: number;
}

const DAY = 86_400_000;

/**
 * The audit anchors in R2: `audit/anchors/<date>/<hour>.json`. A write is conditional on the key
 * being free (and the prefix is bucket-locked), so an hour's anchor is written once. `latest`
 * lists a day's prefix at a time, today's first, and reads the last key: one anchor an hour is at
 * most 24 keys a listing, and a week's lookback bounds the calls.
 */
export function createR2AuditAnchors(
  bucket: R2AnchorBucketLike,
  layout: R2AnchorLayout,
): AuditAnchors {
  return {
    async write(anchor) {
      const stored = await bucket.put(layout.keyOf(anchor.anchoredAt), JSON.stringify(anchor), {
        httpMetadata: { contentType: 'application/json' },
        onlyIf: { etagDoesNotMatch: '*' },
      });
      return stored !== null;
    },
    async latest(now) {
      for (let back = 0; back <= layout.lookbackDays; back++) {
        const dayPrefix = layout.keyOf(now - back * DAY).replace(/\/\d{2}\.json$/, '/');
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await bucket.list({ prefix: dayPrefix, cursor });
          keys.push(...page.objects.map((o) => o.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        const last = keys.sort().at(-1);
        if (!last) continue;
        const object = await bucket.get(last);
        if (object) return JSON.parse(await object.text()) as Anchor;
      }
      return undefined;
    },
  };
}
