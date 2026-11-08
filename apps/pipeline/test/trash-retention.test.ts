import { env } from 'cloudflare:workers';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getSchedulerStatus,
  publishContentType,
  SYSTEM_CALLER,
  setTrashRetention,
  sweepExpiredTrash,
  trashEntry,
} from '@commerceworker/application';
import { type FieldDefinition, type Principal, SCOPES } from '@commerceworker/domain';
import { createD1Store } from '@commerceworker/store';
import { FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { CRON_EVERY, CRON_JOBS, finishTick, startTick, sweep } from '../src/heartbeat';

/**
 * The cron's trash retention sweep on D1, as `scheduled` runs it on the top-of-hour tick: under
 * its own heartbeat job, purging what a space's window has passed and nothing else, and doing
 * nothing more when the tick runs again. An archived entry's `updated_at` is when it was trashed;
 * the store stamps it with database time, so the test moves it back by hand.
 */
const DAY = 24 * 60 * 60 * 1000;
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const uid = () => crypto.randomUUID();

async function trashedAgo(
  scope: { spaceId: string; environmentId: string },
  id: string,
  days: number,
) {
  await env.DB.prepare(
    'UPDATE entries SET updated_at = ? WHERE space_id = ? AND environment_id = ? AND id = ?',
  )
    .bind(Date.now() - days * DAY, scope.spaceId, scope.environmentId, id)
    .run();
}

describe('trash retention sweep', () => {
  it('runs hourly under its own heartbeat job', () => {
    expect(CRON_JOBS.trashRetention).toBe('trash-retention');
    expect(CRON_EVERY.trashRetention).toBe(60 * 60 * 1000);
  });

  it('purges entries past the window, keeps the rest, and is a no-op the next tick', async () => {
    const ctx: AppContext = {
      store: createD1Store(env.DB),
      clock: new FixedClock(new Date()),
      ids: { newId: uid },
    };
    const kept = `kept-${uid()}`;
    const swept = `swept-${uid()}`;
    const scopes = [kept, swept].map((spaceId) => ({ spaceId, environmentId: 'main' }));
    const ids: Record<string, { old: string; young: string }> = {};
    for (const scope of scopes) {
      await createSpace(ctx, {
        spaceId: scope.spaceId,
        name: scope.spaceId,
        defaultLocale: 'en-US',
      });
      await createContentType(ctx, SYSTEM_CALLER, scope, {
        apiId: 'note',
        name: 'Note',
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
        ] as FieldDefinition[],
      });
      await publishContentType(ctx, scope, 'note');
      const make = async (title: string) => {
        const { entry } = await createEntry(ctx, scope, {
          contentTypeApiId: 'note',
          fields: { title: { 'en-US': title } },
        });
        await trashEntry(ctx, scope, entry.id);
        return entry.id;
      };
      ids[scope.spaceId] = { old: await make('old'), young: await make('young') };
      await trashedAgo(scope, ids[scope.spaceId]?.old ?? '', 40);
      await trashedAgo(scope, ids[scope.spaceId]?.young ?? '', 5);
    }
    // Only `swept` turned retention on: `kept` keeps its trash however old.
    await setTrashRetention(ctx, admin, { spaceId: swept, environmentId: 'main' }, 30);

    const runTick = async () => {
      const tick = startTick(ctx);
      const results: unknown[] = [];
      await sweep(
        tick,
        CRON_JOBS.trashRetention,
        async () => results.push(await sweepExpiredTrash(ctx, { limit: 1000 })),
        (err) => {
          throw err;
        },
      );
      expect(await finishTick(ctx, tick)).toBe(true);
      return results[0];
    };

    expect(await runTick()).toMatchObject({ purged: 1, refused: 0 });
    const [keptScope, sweptScope] = scopes as [(typeof scopes)[0], (typeof scopes)[0]];
    expect(await ctx.store.entries.get(sweptScope, ids[swept]?.old ?? '')).toBeNull();
    expect(await ctx.store.entries.get(sweptScope, ids[swept]?.young ?? '')).not.toBeNull();
    expect(await ctx.store.entries.get(keptScope, ids[kept]?.old ?? '')).not.toBeNull();

    // A second tick (or a redelivered one) finds nothing more to purge.
    expect(await runTick()).toMatchObject({ purged: 0, refused: 0 });
    const status = await getSchedulerStatus(ctx, admin);
    expect(status.jobs.find((j) => j.job === CRON_JOBS.trashRetention)?.lastSuccessAt).toBe(
      ctx.clock.now().toISOString(),
    );
  });
});
