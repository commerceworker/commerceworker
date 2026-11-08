import {
  type AppContext,
  createAsset,
  createContentType,
  createEntry,
  createSpace,
  getDeliveredAsset,
  getLocaleSettings,
  getPublishedEntry,
  listDeliveredAssets,
  listPublishedEntries,
  publishAsset,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  setLocaleSettings,
} from '@commerceworker/application';
import {
  type FieldDefinition,
  NotFoundError,
  type Principal,
  SCOPES,
} from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { FakeBlobStore, FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Per-locale settings on D1 (0025_locale_settings): stored beside `locales`, read with the space
 * config (on the Delivery read too, in the same statement), kept when the space is re-created.
 * Each test makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

async function space() {
  const ctx: AppContext = {
    store,
    clock: new FixedClock(new Date('2026-05-01T09:00:00.000Z')),
    ids: { newId: () => crypto.randomUUID() },
  };
  const spaceId = `locales-${crypto.randomUUID()}`;
  await createSpace(ctx, {
    spaceId,
    name: 'Locales',
    defaultLocale: 'en',
    locales: ['en', 'fr', 'ar'],
  });
  return { ctx, spaceId, scope: { spaceId, environmentId: 'main' } };
}

describe('locale settings on D1', () => {
  it('stores them, reads them with the config, and keeps them when the space is re-created', async () => {
    const { ctx, spaceId, scope } = await space();
    const raw = () =>
      testDb.prepare('SELECT locale_settings FROM spaces WHERE id = ?').bind(spaceId).first<{
        locale_settings: string | null;
      }>();
    expect((await raw())?.locale_settings).toBeNull();

    await setLocaleSettings(ctx, admin, scope, {
      fr: { delivered: false },
      ar: { direction: 'ltr' },
    });
    expect((await store.spaces.getConfig(scope))?.localeSettings).toEqual({
      fr: { delivered: false },
      ar: { direction: 'ltr' },
    });
    const read = await store.delivery.read(scope, { config: true });
    expect(read.config?.localeSettings).toEqual({
      fr: { delivered: false },
      ar: { direction: 'ltr' },
    });

    // Re-created (as `space_create` on an existing id does): the settings stay.
    const config = await store.spaces.getConfig(scope);
    if (!config) throw new Error('space missing');
    const { localeSettings: _kept, ...without } = config;
    await store.spaces.create({ ...without, name: 'Renamed' });
    expect((await getLocaleSettings(ctx, scope)).localeSettings).toEqual({
      en: { delivered: true, direction: 'ltr' },
      fr: { delivered: false, direction: 'ltr' },
      ar: { delivered: true, direction: 'ltr' },
    });

    // Back to the defaults for every locale: the column is cleared, not left as {}.
    await setLocaleSettings(ctx, admin, scope, { fr: {}, ar: {} });
    expect((await raw())?.locale_settings).toBeNull();
  });

  it('writes over only the settings the caller read, else the unit is a conflict', async () => {
    const { ctx, spaceId, scope } = await space();
    await setLocaleSettings(ctx, admin, scope, { ar: { direction: 'ltr' } });
    // Read before that change: the write loses, and nothing in its unit commits.
    await expect(
      store.withTransaction(async (tx) => {
        await tx.spaces.setLocaleSettings(spaceId, { fr: { delivered: false } }, undefined);
      }),
    ).rejects.toThrow(TransactionConflictError);
    expect((await store.spaces.getConfig(scope))?.localeSettings).toEqual({
      ar: { direction: 'ltr' },
    });
    // Over what is there now, it lands; so does the use-case, which re-reads.
    await store.withTransaction(async (tx) => {
      await tx.spaces.setLocaleSettings(
        spaceId,
        { ar: { direction: 'ltr' }, fr: { delivered: false } },
        { ar: { direction: 'ltr' } },
      );
    });
    const view = await setLocaleSettings(ctx, admin, scope, { fr: { delivered: true } });
    expect(view.localeSettings.fr?.delivered).toBe(true);
    expect(view.localeSettings.ar?.direction).toBe('ltr');
  });

  it('leaves an undelivered locale out of asset text, the settings riding the asset statement', async () => {
    const { ctx, scope } = await space();
    const blob = new FakeBlobStore();
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: 'a.jpg',
      contentType: 'image/jpeg',
      title: { en: 'Hero', fr: 'Héros', ar: 'بطل' },
    });
    await store.assets.save(scope, { ...asset, file: { ...asset.file, size: 1, width: 1 } });
    await publishAsset(ctx, scope, asset.id);
    expect((await getDeliveredAsset(ctx, scope, asset.id)).title).toHaveProperty('fr');

    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });
    expect((await getDeliveredAsset(ctx, scope, asset.id)).title).toEqual({
      en: 'Hero',
      ar: 'بطل',
    });
    const [listed] = (await listDeliveredAssets(ctx, scope)).items;
    expect(listed?.title).toEqual({ en: 'Hero', ar: 'بطل' });
    const read = await store.delivery.read(scope, { assetPage: {}, assetLocales: true });
    expect(read.assetLocales).toEqual({ fr: { delivered: false } });
    // Nothing found, nothing carried: the empty answer needs no settings.
    const missing = await store.delivery.read(scope, { assetId: 'nope', assetLocales: true });
    expect(missing).toEqual({ asset: null });
  });

  it('serves no undelivered locale through Delivery', async () => {
    const { ctx, scope } = await space();
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: true,
          required: false,
          position: 0,
        },
      ] as FieldDefinition[],
    });
    await publishContentType(ctx, scope, 'note');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { en: 'Hello', fr: 'Bonjour', ar: 'مرحبا' } },
    });
    await publishEntry(ctx, scope, entry.id);
    await setLocaleSettings(ctx, admin, scope, { fr: { delivered: false } });

    await expect(getPublishedEntry(ctx, scope, entry.id, { locale: 'fr' })).rejects.toThrow(
      NotFoundError,
    );
    expect((await getPublishedEntry(ctx, scope, entry.id)).fields.title).toEqual({
      en: 'Hello',
      ar: 'مرحبا',
    });
    // An entry titled only in fr: the store's any-locale fallback never compares that value.
    const { entry: french } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { fr: 'Seulement' } },
    });
    await publishEntry(ctx, scope, french.id);
    const query = {
      contentTypeApiId: 'note',
      locale: 'en',
      filters: [{ field: 'title', op: 'eq' as const, value: 'Seulement' }],
    };
    expect((await store.entries.listPublished(scope, query)).map((e) => e.entryId)).toEqual([
      french.id,
    ]);
    expect(await store.entries.listPublished(scope, { ...query, hiddenLocales: ['fr'] })).toEqual(
      [],
    );
    expect(await listPublishedEntries(ctx, scope, query)).toEqual([]);
  });
});
