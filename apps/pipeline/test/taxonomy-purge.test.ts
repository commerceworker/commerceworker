import { env } from 'cloudflare:workers';
import {
  type AppContext,
  consumeEvent,
  createSpace,
  createTag,
  deleteTag,
  updateTag,
} from '@commerceworker/application';
import type { DomainEvent } from '@commerceworker/domain';
import { createD1Store } from '@commerceworker/store';
import { RecordingWebhookSender } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { isTaxonomyRepairTick } from '../src/heartbeat';
import { newPurgePlan, planPurges } from '../src/purges';

/**
 * Delivery caches its taxonomy reads (labels, slugs, counts) under the scope's tag, like every
 * other read: a vocabulary change must purge it, or an archive page keeps a renamed tag.
 */
const store = createD1Store(env.DB);

describe('taxonomy changes in the engine', () => {
  it('purge the scope’s Delivery cache when a tag is created, changed or deleted', async () => {
    const ctx: AppContext = {
      store,
      clock: { now: () => new Date() },
      ids: { newId: () => crypto.randomUUID() },
    };
    const spaceId = `engine-taxonomy-${crypto.randomUUID().slice(0, 8)}`;
    await createSpace(ctx, { spaceId, name: 'Taxonomy', defaultLocale: 'en-US' });
    const scope = { spaceId, environmentId: 'main' };

    const tag = await createTag(ctx, scope, { name: 'Purged' });
    await updateTag(ctx, scope, tag.id, { slug: 'purged-tag' });
    await deleteTag(ctx, scope, tag.id);

    const rows = await env.DB.prepare(
      "select payload from outbox where json_extract(payload, '$.scope.spaceId') = ? and json_extract(payload, '$.type') = 'taxonomy.changed' order by rowid",
    )
      .bind(spaceId)
      .all<{ payload: string }>();
    const events = rows.results.map((r) => JSON.parse(r.payload) as DomainEvent);
    expect(events).toHaveLength(3);

    const plan = newPurgePlan();
    for (const e of events) {
      // The consumer has no effect of its own for it, and must not fail on it.
      await consumeEvent(ctx, { sender: new RecordingWebhookSender() }, e);
      await planPurges(ctx, plan, e);
    }
    expect([...plan.delivery]).toEqual([`cw:${spaceId}:main`]);
    expect(plan.media.size + plan.revoked.size).toBe(0);
  });

  it('repairs taxonomy once a day, on the 04:15 UTC tick', () => {
    expect(isTaxonomyRepairTick(Date.UTC(2026, 0, 1, 4, 15))).toBe(true);
    expect(isTaxonomyRepairTick(Date.UTC(2026, 0, 1, 4, 16))).toBe(false);
    expect(isTaxonomyRepairTick(Date.UTC(2026, 0, 1, 3, 15))).toBe(false);
  });
});
