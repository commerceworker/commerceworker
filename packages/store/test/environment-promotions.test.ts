import {
  type AppContext,
  approvePromotion,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  listPromotions,
  publishContentType,
  publishEntry,
  requestPromotion,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import { type Principal, SCOPES } from '@commerceworker/domain';
import type { Clock, IdGenerator } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Promotions on D1: the record and its announcing event in one write, the approval's
 * compare-and-set, and the pinned version applied through the use-cases.
 */
const clock: Clock = { now: () => new Date() };
const ids: IdGenerator = { newId: () => crypto.randomUUID() };
const store = createD1Store(testDb);
const ctx: AppContext = { store, clock, ids };
const spaceId = `promo-${crypto.randomUUID().slice(0, 8)}`;
const staging = { spaceId, environmentId: 'staging' };
const main = { spaceId, environmentId: 'main' };
const ada: Principal = { spaceId, kind: 'user', subject: 'ada', scopes: [SCOPES.contentPublish] };
const grace: Principal = { ...ada, subject: 'grace' };

describe('promotions on D1', () => {
  it('waits for approval into main, applies once, and keeps the record and its event together', async () => {
    await createSpace(ctx, { spaceId, name: 'P', defaultLocale: 'en-US', locales: ['en-US'] });
    await createEnvironment(ctx, spaceId, 'staging');
    for (const scope of [staging, main]) {
      await createContentType(ctx, SYSTEM_CALLER, scope, {
        apiId: 'page',
        name: 'Page',
        displayField: 'title',
        fields: [
          {
            apiId: 'title',
            name: 'Title',
            type: 'Symbol',
            localized: false,
            required: true,
            position: 0,
          },
        ],
      } as Parameters<typeof createContentType>[3]);
      await publishContentType(ctx, scope, 'page');
    }
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Launch' } },
    });
    await publishEntry(ctx, staging, e.entry.id);

    const p = await requestPromotion(ctx, ada, spaceId, { source: 'staging', target: 'main' });
    expect(p.status).toBe('awaiting_approval');
    const waiting = await testDb
      .prepare(
        "SELECT count(*) AS n FROM outbox WHERE type = 'promotion.awaiting_approval' AND payload LIKE ?",
      )
      .bind(`%${p.id}%`)
      .first<{ n: number }>();
    expect(waiting?.n).toBe(1);
    expect(
      (await listPromotions(ctx, spaceId, { status: 'awaiting_approval' })).map((x) => x.id),
    ).toEqual([p.id]);

    // Two approvals race: the compare-and-set lets exactly one apply.
    const raced = await Promise.allSettled([
      approvePromotion(ctx, grace, spaceId, p.id),
      approvePromotion(ctx, grace, spaceId, p.id),
    ]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const done = await store.promotions.get(spaceId, p.id);
    expect(done).toMatchObject({
      status: 'completed',
      decidedBy: 'grace',
      result: { mismatched: [] },
    });
    expect((await store.entries.getPublished(main, e.entry.id))?.fields.title).toEqual({
      'en-US': 'Launch',
    });
  });

  it('moves a promotion only out of the status it is in', async () => {
    const p = (await listPromotions(ctx, spaceId))[0];
    if (!p) throw new Error('needs the first test');
    expect(
      await store.promotions.transition(spaceId, p.id, 'awaiting_approval', { status: 'rejected' }),
    ).toBeNull();
    expect((await store.promotions.get(spaceId, p.id))?.status).toBe('completed');
  });
});
