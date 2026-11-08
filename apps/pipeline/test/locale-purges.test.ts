import { env } from 'cloudflare:workers';
import {
  type AppContext,
  consumeEvent,
  createSpace,
  setLocaleSettings,
} from '@commerceworker/application';
import { type DomainEvent, type Principal, SCOPES } from '@commerceworker/domain';
import { deliveryScopeTag } from '@commerceworker/platform/messages';
import { createD1Store } from '@commerceworker/store';
import { RecordingWebhookSender } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { newPurgePlan, planPurges } from '../src/purges';

/**
 * A space's locale settings belong to every environment of it: turning a locale off purges what
 * each environment delivers, once per batch, however often the event is redelivered, and nothing
 * of another space.
 */
const store = createD1Store(env.DB);
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

describe('locale settings changes in the engine', () => {
  it('purge every environment of the space’s delivery responses', async () => {
    const ctx: AppContext = {
      store,
      clock: { now: () => new Date() },
      ids: { newId: () => crypto.randomUUID() },
    };
    const spaceId = `engine-locales-${crypto.randomUUID()}`;
    await createSpace(ctx, {
      spaceId,
      name: 'Locales',
      defaultLocale: 'en-US',
      locales: ['en-US', 'fr-FR'],
      environments: ['main', 'staging'],
    });
    await setLocaleSettings(
      ctx,
      admin,
      { spaceId, environmentId: 'main' },
      {
        'fr-FR': { delivered: false },
      },
    );
    const rows = await env.DB.prepare(
      "select payload from outbox where json_extract(payload, '$.scope.spaceId') = ? order by rowid",
    )
      .bind(spaceId)
      .all<{ payload: string }>();
    const events = rows.results
      .map((r) => JSON.parse(r.payload) as DomainEvent)
      .filter((e) => e.type === 'space_locales.changed');
    expect(events).toHaveLength(1);
    const plan = newPurgePlan();
    for (let run = 0; run < 2; run++) {
      await consumeEvent(ctx, { sender: new RecordingWebhookSender() }, events[0] as DomainEvent);
      await planPurges(ctx, plan, events[0] as DomainEvent);
    }
    expect([...plan.delivery].sort()).toEqual(
      [deliveryScopeTag(spaceId, 'main'), deliveryScopeTag(spaceId, 'staging')].sort(),
    );
    expect(plan.media.size + plan.revoked.size).toBe(0);
  });
});
