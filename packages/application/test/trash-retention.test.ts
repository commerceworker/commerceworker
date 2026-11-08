import { ForbiddenError, type Principal, SCOPES, ValidationError } from '@commerceworker/domain';
import type { HookDispatcher, HookResult } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  getTrashSettings,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  setTrashRetention,
  sweepExpiredTrash,
  trashEntry,
} from '../src/index';

const DAY = 24 * 60 * 60 * 1000;
const main = { spaceId: 's1', environmentId: 'main' };
const staging = { spaceId: 's1', environmentId: 'staging' };
const otherSpace = { spaceId: 's2', environmentId: 'main' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const editor: Principal = { spaceId: 's1', kind: 'cma', scopes: [SCOPES.contentWrite] };

let ctx: AppContext;
let store: InMemoryContentStore;
let clock: FixedClock;

beforeEach(async () => {
  store = new InMemoryContentStore();
  clock = new FixedClock();
  // The store stamps `updated_at` (when an entry was trashed) from the same clock.
  store.nowMs = () => clock.now().getTime();
  ctx = { store, clock, ids: new SequenceIdGenerator('e') };
  for (const spaceId of ['s1', 's2']) {
    store.seedSpace({ spaceId, defaultLocale: 'en-US', locales: ['en-US'] });
    await store.spaces.createEnvironment(spaceId, 'main', 'main');
  }
  await store.spaces.createEnvironment('s1', 'staging', 'staging');
  for (const scope of [main, staging, otherSpace]) {
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
        {
          apiId: 'see',
          name: 'See',
          type: 'Link',
          linkType: 'Entry',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(ctx, scope, 'note');
  }
});

async function trashed(scope: typeof main, title: string): Promise<string> {
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'note',
    fields: { title: { 'en-US': title } },
  });
  await trashEntry(ctx, scope, entry.id);
  return entry.id;
}

const exists = async (scope: typeof main, id: string) =>
  (await store.entries.get(scope, id)) !== null;

describe('the trash retention setting', () => {
  it('is off until a space admin sets it, and can be turned off again', async () => {
    expect(await getTrashSettings(ctx, main)).toEqual({ retentionDays: null });
    expect(await setTrashRetention(ctx, admin, main, 30)).toEqual({ retentionDays: 30 });
    expect(await getTrashSettings(ctx, main)).toEqual({ retentionDays: 30 });
    // Per space: every environment of it, and no other space.
    expect(await getTrashSettings(ctx, staging)).toEqual({ retentionDays: 30 });
    expect(await getTrashSettings(ctx, otherSpace)).toEqual({ retentionDays: null });
    await setTrashRetention(ctx, admin, main, null);
    expect(await getTrashSettings(ctx, main)).toEqual({ retentionDays: null });
  });

  it('takes whole days from 1 to 3650, from a space admin only', async () => {
    for (const bad of [0, -1, 1.5, 3651]) {
      await expect(setTrashRetention(ctx, admin, main, bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    await expect(setTrashRetention(ctx, editor, main, 7)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('the retention sweep', () => {
  it('purges nothing while retention is off, however old the trash', async () => {
    const id = await trashed(main, 'old');
    clock.advance(5000 * DAY);
    expect(await sweepExpiredTrash(ctx)).toEqual({ purged: 0, refused: 0 });
    expect(await exists(main, id)).toBe(true);
  });

  it('purges what was trashed longer ago than the window, in every environment of the space', async () => {
    await setTrashRetention(ctx, admin, main, 30);
    const old = await trashed(main, 'old');
    const oldStaging = await trashed(staging, 'old staging');
    const elsewhere = await trashed(otherSpace, 'other space');
    clock.advance(20 * DAY);
    const recent = await trashed(main, 'recent');
    const { entry: live } = await createEntry(ctx, main, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'not trashed' } },
    });
    clock.advance(11 * DAY);

    expect(await sweepExpiredTrash(ctx)).toEqual({ purged: 2, refused: 0 });
    expect(await exists(main, old)).toBe(false);
    expect(await exists(staging, oldStaging)).toBe(false);
    expect(await exists(main, recent)).toBe(true);
    expect(await exists(main, live.id)).toBe(true);
    // Another space without retention keeps its trash.
    expect(await exists(otherSpace, elsewhere)).toBe(true);

    // A second run finds nothing more to do.
    expect(await sweepExpiredTrash(ctx)).toEqual({ purged: 0, refused: 0 });
  });

  it('keeps an entry a published entry links to, and is not stalled by it', async () => {
    await setTrashRetention(ctx, admin, main, 1);
    const { entry: target } = await createEntry(ctx, main, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'target' } },
    });
    const { entry: linker } = await createEntry(ctx, main, {
      contentTypeApiId: 'note',
      fields: {
        title: { 'en-US': 'linker' },
        see: { 'en-US': { id: target.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, main, target.id);
    await publishEntry(ctx, main, linker.id);
    await trashEntry(ctx, main, target.id);
    clock.advance(DAY);
    const after = await trashed(main, 'after');
    clock.advance(2 * DAY);

    // With room for one purge, the linked (older) entry doesn't take it.
    expect(await sweepExpiredTrash(ctx, { limit: 1 })).toEqual({ purged: 1, refused: 0 });
    expect(await exists(main, target.id)).toBe(true);
    expect(await exists(main, after)).toBe(false);
  });

  it('purges in bounded runs, shared between environments', async () => {
    await setTrashRetention(ctx, admin, main, 1);
    for (let i = 0; i < 5; i++) await trashed(main, `m${i}`);
    const inStaging = await trashed(staging, 's');
    clock.advance(2 * DAY);

    // Hour by hour the environments take turns going first, so within two runs staging has had
    // its share however large main's trash is.
    expect(await sweepExpiredTrash(ctx, { limit: 2 })).toEqual({ purged: 2, refused: 0 });
    clock.advance(60 * 60 * 1000);
    expect(await sweepExpiredTrash(ctx, { limit: 2 })).toEqual({ purged: 2, refused: 0 });
    expect(await exists(staging, inStaging)).toBe(false);
    expect(await sweepExpiredTrash(ctx, { limit: 100 })).toEqual({ purged: 2, refused: 0 });
  });

  it('resumes after the last refusal, so more than ten held entries never stall the rest', async () => {
    const held = new Set<string>();
    ctx = {
      ...ctx,
      hooks: {
        async dispatch<T>(hook: string, payload: T): Promise<HookResult<T>> {
          const id = (payload as { entryId?: string }).entryId ?? '';
          return hook === 'entry:beforePurge' && held.has(id)
            ? { veto: { hook: 'com.example.hold', reason: 'Legal hold' } }
            : { payload };
        },
      },
    };
    await setTrashRetention(ctx, admin, main, 1);
    for (let i = 0; i < 12; i++) held.add(await trashed(main, `held${i}`));
    const behind = [
      await trashed(main, 'b0'),
      await trashed(main, 'b1'),
      await trashed(main, 'b2'),
    ];
    clock.advance(2 * DAY);

    // The first run meets ten held entries and stops there, remembering where.
    expect(await sweepExpiredTrash(ctx)).toEqual({ purged: 0, refused: 10 });
    expect(await store.spaces.getTrashSweepCursor(main)).not.toBeNull();
    // The next resumes after them: two more refusals, then the three behind go.
    expect(await sweepExpiredTrash(ctx)).toEqual({ purged: 3, refused: 2 });
    for (const id of behind) expect(await exists(main, id)).toBe(false);
    // Read to its end, it starts from the oldest again, retrying what was held.
    expect(await store.spaces.getTrashSweepCursor(main)).toBeNull();
    held.delete([...held][0] ?? '');
    expect(await sweepExpiredTrash(ctx)).toEqual({ purged: 1, refused: 10 });
  });

  it('stops at twice its purge limit in refusals across environments', async () => {
    ctx = {
      ...ctx,
      hooks: {
        async dispatch<T>(hook: string, payload: T): Promise<HookResult<T>> {
          return hook === 'entry:beforePurge'
            ? { veto: { hook: 'com.example.hold', reason: 'Legal hold' } }
            : { payload };
        },
      },
    };
    await setTrashRetention(ctx, admin, main, 1);
    for (let i = 0; i < 6; i++) await trashed(main, `m${i}`);
    for (let i = 0; i < 6; i++) await trashed(staging, `s${i}`);
    clock.advance(2 * DAY);
    expect(await sweepExpiredTrash(ctx, { limit: 2 })).toEqual({ purged: 0, refused: 4 });
  });

  it('reads on past refused entries to the expired ones behind, in every environment', async () => {
    const held = new Set<string>();
    ctx = {
      ...ctx,
      hooks: {
        async dispatch<T>(hook: string, payload: T): Promise<HookResult<T>> {
          const id = (payload as { entryId?: string }).entryId ?? '';
          return hook === 'entry:beforePurge' && held.has(id)
            ? { veto: { hook: 'com.example.hold', reason: 'Legal hold' } }
            : { payload };
        },
      },
    };
    await setTrashRetention(ctx, admin, main, 1);
    // Main's five oldest are on hold; three expired entries sit behind them.
    for (let i = 0; i < 5; i++) held.add(await trashed(main, `held${i}`));
    const behind = [
      await trashed(main, 'b0'),
      await trashed(main, 'b1'),
      await trashed(main, 'b2'),
    ];
    const inStaging = await trashed(staging, 's');
    // More environments of other spaces, all quiet: they must not shrink anyone's share.
    for (let i = 0; i < 30; i++) await store.spaces.createEnvironment('s2', `quiet${i}`, `q${i}`);
    await setTrashRetention(ctx, admin, otherSpace, 1);
    clock.advance(2 * DAY);

    expect(await sweepExpiredTrash(ctx, { limit: 10 })).toEqual({ purged: 4, refused: 5 });
    for (const id of behind) expect(await exists(main, id)).toBe(false);
    expect(await exists(staging, inStaging)).toBe(false);
    for (const id of held) expect(await exists(main, id)).toBe(true);
  });

  it('leaves an entry a plugin refuses to purge, and counts it', async () => {
    const hooks: HookDispatcher = {
      async dispatch<T>(hook: string, payload: T): Promise<HookResult<T>> {
        return hook === 'entry:beforePurge'
          ? { veto: { hook: 'com.example.keep', reason: 'Legal hold' } }
          : { payload };
      },
    };
    ctx = { ...ctx, hooks };
    await setTrashRetention(ctx, admin, main, 1);
    const id = await trashed(main, 'held');
    clock.advance(2 * DAY);
    expect(await sweepExpiredTrash(ctx)).toEqual({ purged: 0, refused: 1 });
    expect(await exists(main, id)).toBe(true);
  });
});
