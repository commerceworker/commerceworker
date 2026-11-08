import { env } from 'cloudflare:workers';
import {
  type AppContext,
  consumeEvent,
  createMenu,
  createSpace,
  deleteMenu,
  updateMenu,
} from '@commerceworker/application';
import type { DomainEvent } from '@commerceworker/domain';
import { deliveryScopeTag } from '@commerceworker/platform/messages';
import { createD1Store } from '@commerceworker/store';
import { RecordingWebhookSender } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { newPurgePlan, planPurges } from '../src/purges';

/**
 * A change to an environment's menus reaches the delivery cache: Delivery serves each menu under
 * the scope's tag, so `menus.changed` purges it, once per batch, however often it is redelivered.
 */
const store = createD1Store(env.DB);

async function eventsOf(spaceId: string): Promise<DomainEvent[]> {
  const rows = await env.DB.prepare(
    "select payload from outbox where json_extract(payload, '$.scope.spaceId') = ? order by rowid",
  )
    .bind(spaceId)
    .all<{ payload: string }>();
  return rows.results.map((r) => JSON.parse(r.payload) as DomainEvent);
}

describe('menu changes in the engine', () => {
  it('purge the environment’s delivery responses, and are handled without effects', async () => {
    const ctx: AppContext = {
      store,
      clock: { now: () => new Date() },
      ids: { newId: () => crypto.randomUUID() },
    };
    const spaceId = `engine-menus-${crypto.randomUUID()}`;
    await createSpace(ctx, { spaceId, name: 'Menus', defaultLocale: 'en-US' });
    const scope = { spaceId, environmentId: 'main' };
    const menu = await createMenu(ctx, scope, { handle: 'main', name: 'Main' });
    await updateMenu(ctx, scope, menu.id, { name: 'Header', revision: menu.revision });
    await deleteMenu(ctx, scope, menu.id);

    const events = (await eventsOf(spaceId)).filter((e) => e.type === 'menus.changed');
    expect(events).toHaveLength(3);
    const plan = newPurgePlan();
    for (const e of events) {
      // Redelivered too: a second run plans the same single tag.
      for (let run = 0; run < 2; run++) {
        await consumeEvent(ctx, { sender: new RecordingWebhookSender() }, e);
        await planPurges(ctx, plan, e);
      }
    }
    expect([...plan.delivery]).toEqual([deliveryScopeTag(spaceId, 'main')]);
    expect(plan.media.size + plan.revoked.size).toBe(0);
  });
});
