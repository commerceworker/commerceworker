import { ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getPreviewEntry,
  getPublishedEntry,
  listPreviewEntries,
  publishEntry,
  SYSTEM_CALLER,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function makeContext(): { ctx: AppContext; store: InMemoryContentStore } {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx, store };
}

describe('P2: provisioning, preview, locale fallback', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ({ ctx } = makeContext());
  });

  it('provisions a space over the use-case (no manual seeding)', async () => {
    const config = await createSpace(ctx, {
      spaceId: 'shop',
      name: 'Shop',
      defaultLocale: 'en-US',
      locales: ['en-US', 'de-DE'],
      fallbacks: { 'de-DE': 'en-US' },
    });
    expect(config.locales).toContain('de-DE');
    const loaded = await ctx.store.spaces.getConfig(scope);
    expect(loaded?.name).toBe('Shop');
  });

  it('rejects a default locale not in the locales list', async () => {
    await expect(
      createSpace(ctx, { spaceId: 'x', name: 'X', defaultLocale: 'fr-FR', locales: ['en-US'] }),
    ).rejects.toThrowError(ValidationError);
  });

  async function seedProductType() {
    await createSpace(ctx, {
      spaceId: 'shop',
      name: 'Shop',
      defaultLocale: 'en-US',
      locales: ['en-US', 'de-DE'],
      fallbacks: { 'de-DE': 'en-US' },
    });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'product',
      name: 'Product',
      displayField: 'name',
      fields: [
        {
          apiId: 'name',
          name: 'Name',
          type: 'Symbol',
          localized: true,
          required: true,
          position: 0,
        },
      ],
    });
  }

  it('preview serves drafts that delivery does not', async () => {
    await seedProductType();
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'product',
      fields: { name: { 'en-US': 'Widget' } },
    });

    // Preview sees the draft immediately.
    const previewed = await getPreviewEntry(ctx, scope, created.entry.id);
    expect(previewed.status).toBe('draft');
    expect((previewed.fields.name as Record<string, string>)['en-US']).toBe('Widget');

    // Delivery does not (not published).
    await expect(getPublishedEntry(ctx, scope, created.entry.id)).rejects.toThrow(/not.*found/i);

    const drafts = await listPreviewEntries(ctx, scope, { contentTypeApiId: 'product' });
    expect(drafts).toHaveLength(1);
  });

  it('resolves a requested locale with fallback to the default', async () => {
    await seedProductType();
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'product',
      fields: { name: { 'en-US': 'Widget' } }, // no de-DE value
    });
    await publishEntry(ctx, scope, created.entry.id);

    // Requesting de-DE flattens fields and falls back to en-US.
    const de = await getPublishedEntry(ctx, scope, created.entry.id, { locale: 'de-DE' });
    expect(de.fields.name).toBe('Widget');

    // Without a locale, the full localized map is returned.
    const raw = await getPublishedEntry(ctx, scope, created.entry.id);
    expect((raw.fields.name as Record<string, string>)['en-US']).toBe('Widget');
  });
});
