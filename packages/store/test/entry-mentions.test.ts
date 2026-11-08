import type { AppContext } from '@commerceworker/application';
import {
  createContentType,
  createEntry,
  createSpace,
  publishContentType,
  SYSTEM_CALLER,
  updateEntry,
} from '@commerceworker/application';
import type { Clock, IdGenerator } from '@commerceworker/ports';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * `entries.idsMentioning` against D1: it reads the current version's fields only, within one
 * environment, and honours its limit. Deleting an asset relies on it to see draft links.
 */

const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const seqIds = (prefix: string): IdGenerator => {
  let n = 0;
  return { newId: () => `${prefix}-${String(++n).padStart(4, '0')}` };
};

describe('entries that mention a text on D1', () => {
  const runId = crypto.randomUUID();
  const scope = { spaceId: `men-${runId}`, environmentId: 'main' };
  const other = { spaceId: `men-other-${runId}`, environmentId: 'main' };
  const store = createD1Store(testDb);
  const ctx: AppContext = { store, clock, ids: seqIds(`m-${runId}`) };
  const needle = `needle-${runId}`;
  const page = (title: string) => ({
    contentTypeApiId: 'page',
    fields: { title: { 'en-US': title } },
  });
  let current = '';
  let second = '';
  let superseded = '';

  beforeAll(async () => {
    for (const s of [scope, other]) {
      await createSpace(ctx, { spaceId: s.spaceId, name: 'M', defaultLocale: 'en-US' });
      await createContentType(ctx, SYSTEM_CALLER, s, {
        apiId: 'page',
        name: 'Page',
        displayField: 'title',
        fields: [
          {
            apiId: 'title',
            name: 'Title',
            type: 'Symbol',
            localized: false,
            required: false,
            position: 0,
          },
        ],
      });
      await publishContentType(ctx, s, 'page');
    }
    current = (await createEntry(ctx, scope, page(needle))).entry.id;
    second = (await createEntry(ctx, scope, page(`also ${needle}`))).entry.id;
    superseded = (await createEntry(ctx, scope, page(needle))).entry.id;
    await updateEntry(ctx, scope, superseded, { title: { 'en-US': 'moved on' } });
    await createEntry(ctx, scope, page('unrelated'));
    await createEntry(ctx, other, page(needle));
  });

  it('finds current versions in this environment only, not superseded ones', async () => {
    const ids = await store.entries.idsMentioning(scope, needle, 10);
    expect(ids.sort()).toEqual([current, second].sort());
  });

  it('stops at the limit', async () => {
    await expect(store.entries.idsMentioning(scope, needle, 1)).resolves.toHaveLength(1);
  });

  it('finds nothing for a text nobody mentions', async () => {
    await expect(store.entries.idsMentioning(scope, `absent-${runId}`, 10)).resolves.toEqual([]);
  });
});
