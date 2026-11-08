import type { EntryMovedEvent } from '@commerceworker/domain';
import { deliveryScopeTag } from '@commerceworker/platform/messages';
import { describe, expect, it } from 'vitest';
import { newPurgePlan, planPurges } from '../src/purges';

/**
 * A move in a type's manual order is live: Delivery's lists ordered by `sys.position` change at
 * once for a published entry, and not at all for a draft.
 */
describe('entry moves in the engine', () => {
  const scope = { spaceId: 'order', environmentId: 'main' };
  const moved = (published: boolean): EntryMovedEvent => ({
    id: 'evt',
    type: 'entry.moved',
    scope,
    occurredAt: new Date().toISOString(),
    entryId: 'e1',
    contentTypeApiId: 'note',
    position: 'V',
    published,
  });
  // A move's purge plan reads nothing from the store.
  const ctx = { store: {} as never };

  it("purges the scope's Delivery cache when a published entry moves", async () => {
    const plan = newPurgePlan();
    await planPurges(ctx, plan, moved(true));
    expect([...plan.delivery]).toEqual([deliveryScopeTag('order', 'main')]);
  });

  it('purges nothing when a draft moves', async () => {
    const plan = newPurgePlan();
    await planPurges(ctx, plan, moved(false));
    expect(plan.delivery.size).toBe(0);
  });
});
