import { ValidationError } from '@commerceworker/domain';
import type { AppExtension } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  appHandlesFieldType,
  createAppExtension,
  createSpace,
  deleteAppExtension,
  listAppExtensions,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('x') };
  return { ctx };
}

describe('app extensions CRUD', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('creates, lists, and deletes a sidebar extension', async () => {
    const app = await createAppExtension(ctx, scope, {
      name: 'word-count',
      target: 'sidebar',
      entryUrl: 'https://example.com/widget',
    });
    expect(app.active).toBe(true);
    expect(app.fieldTypes).toBeUndefined();
    expect(await listAppExtensions(ctx, scope)).toHaveLength(1);
    await deleteAppExtension(ctx, scope, app.id);
    expect(await listAppExtensions(ctx, scope)).toHaveLength(0);
  });

  it('stores field types for a field-editor extension', async () => {
    const app = await createAppExtension(ctx, scope, {
      name: 'color-picker',
      target: 'field-editor',
      entryUrl: 'https://example.com/color',
      fieldTypes: ['Symbol'],
    });
    expect(app.target).toBe('field-editor');
    expect(app.fieldTypes).toEqual(['Symbol']);
  });

  it('rejects an unknown target', async () => {
    await expect(
      createAppExtension(ctx, scope, {
        name: 'x',
        target: 'banner' as AppExtension['target'],
        entryUrl: 'https://example.com',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a non-http url', async () => {
    await expect(
      createAppExtension(ctx, scope, {
        name: 'x',
        target: 'sidebar',
        entryUrl: 'app://bad',
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('appHandlesFieldType', () => {
  const base: AppExtension = {
    id: 'a',
    name: 'x',
    target: 'field-editor',
    entryUrl: 'https://e/',
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('matches any field type when none are declared', () => {
    expect(appHandlesFieldType(base, 'JSON')).toBe(true);
  });

  it('matches only declared field types', () => {
    const app = { ...base, fieldTypes: ['JSON'] };
    expect(appHandlesFieldType(app, 'JSON')).toBe(true);
    expect(appHandlesFieldType(app, 'Symbol')).toBe(false);
  });

  it('never matches a sidebar widget or an inactive extension', () => {
    expect(appHandlesFieldType({ ...base, target: 'sidebar' }, 'JSON')).toBe(false);
    expect(appHandlesFieldType({ ...base, active: false }, 'JSON')).toBe(false);
  });
});
