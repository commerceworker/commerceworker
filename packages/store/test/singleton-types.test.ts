import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getContentType,
  getDeliveredSingleton,
  getPreviewSingleton,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  trashEntry,
  updateContentType,
} from '@commerceworker/application';
import {
  ConflictError,
  type FieldDefinition,
  NotFoundError,
  singletonClaim,
} from '@commerceworker/domain';
import { FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Singleton types on D1 (0027_singleton_types): the flag round-trips through the column, the one
 * entry is held by a row in `entry_unique_values` (so the database's unique index refuses a second
 * however the reads raced), and Delivery reads the type and its published entry in one batch.
 * Each test makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();

const title: FieldDefinition = {
  apiId: 'title',
  name: 'Title',
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
};

async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
  const spaceId = `singletons-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Singletons', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'settings',
    name: 'Settings',
    displayField: 'title',
    fields: [title],
    singleton: true,
  });
  await publishContentType(ctx, scope, 'settings');
  const create = (t: string) =>
    createEntry(ctx, scope, { contentTypeApiId: 'settings', fields: { title: { 'en-US': t } } });
  return { ctx, scope, create };
}

describe('singleton types on D1', () => {
  it('stores the flag in its column and keeps it through a revision', async () => {
    const { ctx, scope } = await harness();
    expect((await getContentType(ctx, scope, 'settings')).singleton).toBe(true);
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'settings', { name: 'Site settings' });
    expect(await store.contentTypes.get(scope, 'settings')).toMatchObject({
      name: 'Site settings',
      singleton: true,
    });
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'settings', { singleton: false });
    expect('singleton' in ((await store.contentTypes.get(scope, 'settings')) ?? {})).toBe(false);
  });

  it('refuses a second entry at the unique index when the reads raced', async () => {
    const { ctx, scope, create } = await harness();
    const first = await create('One');
    expect(
      (await store.entries.findUniqueConflicts(scope, [singletonClaim('settings')])).map(
        (c) => c.entryId,
      ),
    ).toEqual([first.entry.id]);

    // The lost race: the second create's read saw nothing, so only the claim stands in its way.
    const raced: AppContext = {
      ...ctx,
      store: {
        ...store,
        entries: { ...store.entries, list: async () => [] },
        withTransaction: store.withTransaction.bind(store),
      },
    };
    await expect(
      createEntry(raced, scope, {
        contentTypeApiId: 'settings',
        fields: { title: { 'en-US': 'Two' } },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    const live = await store.entries.list(scope, { contentTypeApiId: 'settings' });
    expect(live.map((e) => e.entry.id)).toEqual([first.entry.id]);
  });

  it('frees the claim with the trash, and turns on only over at most one entry', async () => {
    const { ctx, scope, create } = await harness();
    const first = await create('One');
    await trashEntry(ctx, scope, first.entry.id);
    const second = await create('Two');

    await updateContentType(ctx, SYSTEM_CALLER, scope, 'settings', { singleton: false });
    await create('Three');
    await expect(
      updateContentType(ctx, SYSTEM_CALLER, scope, 'settings', { singleton: true }),
    ).rejects.toThrow(second.entry.id);
    expect(await store.entries.findUniqueConflicts(scope, [singletonClaim('settings')])).toEqual(
      [],
    );
  });

  it('serves the published entry by type from Delivery and the current one from Preview', async () => {
    const { ctx, scope, create } = await harness();
    await expect(getDeliveredSingleton(ctx, scope, 'settings')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const one = await create('Live');
    expect((await getPreviewSingleton(ctx, scope, 'settings')).id).toBe(one.entry.id);
    await expect(getDeliveredSingleton(ctx, scope, 'settings')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await publishEntry(ctx, scope, one.entry.id);
    const served = await getDeliveredSingleton(ctx, scope, 'settings', { locale: 'en-US' });
    expect(served).toMatchObject({ id: one.entry.id, fields: { title: 'Live' } });

    // Another space's singleton of the same apiId is not this one's.
    const other = await harness();
    await expect(getDeliveredSingleton(other.ctx, other.scope, 'settings')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
