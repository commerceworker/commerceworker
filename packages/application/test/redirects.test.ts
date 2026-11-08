import {
  ConflictError,
  type FieldDefinition,
  MAX_REDIRECT_IMPORT,
  NotFoundError,
  ValidationError,
} from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  analyzeRedirectSet,
  bulkEntryAction,
  cloneEnvironment,
  collapseRedirects,
  createContentType,
  createEntry,
  createEnvironment,
  createRedirect,
  createSpace,
  deleteRedirect,
  exportSnapshot,
  getRedirect,
  importRedirects,
  importSnapshot,
  listDeliveredRedirects,
  listRedirects,
  publishContentType,
  publishEntry,
  resolveDeliveredRedirect,
  resolveRedirect,
  SYSTEM_CALLER,
  updateContentType,
  updateEntry,
  updateRedirect,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const other = { spaceId: 'site', environmentId: 'staging' };

/** The messages of the ValidationError `p` rejects with, joined. */
const refusal = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ValidationError))
    throw new Error(`expected a ValidationError, got ${String(err)}`);
  return err.issues.map((i) => i.message).join('; ');
};

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

describe('redirects', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('r') };
    await createSpace(ctx, {
      spaceId: 'site',
      name: 'Site',
      defaultLocale: 'en-US',
      locales: ['en-US', 'de'],
    });
    await createEnvironment(ctx, 'site', 'staging');
  });

  const changes = () => store.allEvents().filter((e) => e.type === 'redirects.changed');

  it('creates, reads, lists, updates and deletes, announcing each change', async () => {
    const { redirect } = await createRedirect(ctx, scope, {
      source: '/old/',
      destination: '/new',
      note: 'moved',
    });
    expect(redirect).toMatchObject({
      source: '/old',
      destination: '/new',
      status: 301,
      enabled: true,
      origin: 'manual',
      note: 'moved',
    });
    expect(await getRedirect(ctx, scope, redirect.id)).toEqual(redirect);
    await createRedirect(ctx, scope, { source: '/a', destination: '/b', status: 302 });
    expect((await listRedirects(ctx, scope)).items.map((r) => r.source)).toEqual(['/a', '/old']);
    expect((await listRedirects(ctx, scope, { q: 'MOVED' })).items.map((r) => r.source)).toEqual([
      '/old',
    ]);

    const { redirect: off } = await updateRedirect(ctx, scope, redirect.id, {
      enabled: false,
      note: null,
    });
    expect(off.enabled).toBe(false);
    expect(off.note).toBeUndefined();
    expect(off.destination).toBe('/new');

    await deleteRedirect(ctx, scope, redirect.id);
    await expect(getRedirect(ctx, scope, redirect.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteRedirect(ctx, scope, redirect.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(changes()).toHaveLength(4);
  });

  it('refuses a duplicate source, a loop and a locale the space lacks', async () => {
    await createRedirect(ctx, scope, { source: '/a', destination: '/b' });
    await expect(createRedirect(ctx, scope, { source: '/a/', destination: '/c' })).rejects.toThrow(
      ValidationError,
    );
    // The same source for one locale is a different redirect.
    await createRedirect(ctx, scope, { source: '/a', destination: '/de/b', locale: 'de' });
    expect(await refusal(createRedirect(ctx, scope, { source: '/b', destination: '/a' }))).toMatch(
      /loop/,
    );
    await expect(
      createRedirect(ctx, scope, { source: '/x', destination: '/y', locale: 'fr' }),
    ).rejects.toThrow(ValidationError);
    // Enabling a disabled hop that would close a loop is refused too.
    const { redirect } = await createRedirect(ctx, scope, {
      source: '/b',
      destination: '/a',
      enabled: false,
    });
    expect(await refusal(updateRedirect(ctx, scope, redirect.id, { enabled: true }))).toMatch(
      /loop/,
    );
  });

  it('reports chains on write and collapses them', async () => {
    await createRedirect(ctx, scope, { source: '/b', destination: '/c' });
    const { redirect, chains } = await createRedirect(ctx, scope, {
      source: '/a',
      destination: '/b',
    });
    expect(chains).toEqual([{ id: redirect.id, via: [expect.any(String)], destination: '/c' }]);
    expect((await analyzeRedirectSet(ctx, scope)).chains).toHaveLength(1);
    expect(await collapseRedirects(ctx, scope)).toEqual({ updated: 1 });
    expect((await getRedirect(ctx, scope, redirect.id)).destination).toBe('/c');
    expect((await analyzeRedirectSet(ctx, scope)).chains).toEqual([]);
  });

  it('resolves a path, and Delivery serves only the enabled set', async () => {
    await createRedirect(ctx, scope, { source: '/blog/[slug]', destination: '/posts/[slug]' });
    await createRedirect(ctx, scope, { source: '/off', destination: '/x', enabled: false });
    expect(await resolveRedirect(ctx, scope, '/blog/hi?ref=1')).toMatchObject({
      status: 301,
      location: '/posts/hi?ref=1',
    });
    expect(await resolveRedirect(ctx, scope, '/off')).toBeNull();
    expect((await listDeliveredRedirects(ctx, scope)).map((r) => r.source)).toEqual([
      '/blog/[slug]',
    ]);
    expect(Object.keys((await listDeliveredRedirects(ctx, scope))[0] ?? {})).toEqual([
      'id',
      'source',
      'destination',
      'status',
    ]);
    await expect(resolveDeliveredRedirect(ctx, scope, '/nothing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('keeps each environment’s set to itself', async () => {
    await createRedirect(ctx, scope, { source: '/a', destination: '/b' });
    expect((await listRedirects(ctx, other)).items).toEqual([]);
    expect(await resolveRedirect(ctx, other, '/a')).toBeNull();
    // The same source in another environment is no duplicate.
    await createRedirect(ctx, other, { source: '/a', destination: '/c' });
    expect((await resolveRedirect(ctx, scope, '/a'))?.location).toBe('/b');
  });

  it('checks the set again after losing a race to another writer', async () => {
    await createRedirect(ctx, scope, { source: '/b', destination: '/c' });
    // Another writer commits between this write's read and its commit, once.
    const state = store.redirects.state.bind(store.redirects);
    let raced = false;
    store.redirects.state = async (s) => {
      const read = await state(s);
      if (!raced) {
        raced = true;
        await store.redirects.saveMany(s, [
          {
            id: 'other',
            source: '/c',
            destination: '/a',
            status: 301,
            enabled: true,
            origin: 'manual',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]);
        await store.redirects.advance(s, read.revision);
      }
      return read;
    };
    // The retry sees /c → /a, so /a → /b now closes a loop: refused, not committed.
    expect(await refusal(createRedirect(ctx, scope, { source: '/a', destination: '/b' }))).toMatch(
      /loop/,
    );
    expect((await listRedirects(ctx, scope)).items.map((r) => r.source)).toEqual(['/b', '/c']);
  });

  it('gives up after losing every attempt', async () => {
    store.redirects.state = async () => ({ revision: -1, count: 0 });
    await expect(createRedirect(ctx, scope, { source: '/a', destination: '/b' })).rejects.toThrow(
      TransactionConflictError,
    );
    expect(changes()).toEqual([]);
  });

  describe('import', () => {
    it('takes CSV, adds new sources and updates held ones', async () => {
      const { redirect } = await createRedirect(ctx, scope, { source: '/a', destination: '/x' });
      const csv =
        'source,destination,status,locale,enabled,note\n/a,/b,,,,\n/c,/d,308,de,false,"hi, there"\n/e,/f,,,,\n';
      const report = await importRedirects(ctx, scope, { format: 'csv', data: csv });
      expect(report).toEqual({ dryRun: false, created: 2, updated: 1, unchanged: 0, chains: [] });
      expect((await getRedirect(ctx, scope, redirect.id)).destination).toBe('/b');
      expect(await resolveRedirect(ctx, scope, '/c', 'de')).toBeNull(); // disabled
      const again = await importRedirects(ctx, scope, { format: 'csv', data: csv });
      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    });

    it('takes JSON and reports a dry run without writing', async () => {
      const report = await importRedirects(ctx, scope, {
        format: 'json',
        data: [
          { source: '/a', destination: '/b' },
          { source: '/b', destination: '/c' },
        ],
        dryRun: true,
      });
      expect(report).toMatchObject({ dryRun: true, created: 2 });
      expect(report.chains).toHaveLength(1);
      expect((await listRedirects(ctx, scope)).items).toEqual([]);
      expect(changes()).toEqual([]);
    });

    it('refuses the whole import for any bad row, naming each', async () => {
      const err = await importRedirects(ctx, scope, {
        format: 'json',
        data: [
          { source: '/ok', destination: '/fine' },
          { source: 'nope', destination: '/x' },
          { source: '/y', destination: 'javascript:alert(1)' },
        ],
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues.map((i) => i.field)).toEqual([
        'rows[1].source',
        'rows[2].destination',
      ]);
      expect(
        await refusal(
          importRedirects(ctx, scope, {
            format: 'json',
            data: [
              { source: '/a', destination: '/b' },
              { source: '/a/', destination: '/c' },
            ],
          }),
        ),
      ).toMatch(/also in row 0/);
      expect(
        await refusal(
          importRedirects(ctx, scope, {
            format: 'json',
            data: [
              { source: '/a', destination: '/b' },
              { source: '/b', destination: '/a' },
            ],
          }),
        ),
      ).toMatch(/loop/);
      expect(
        await refusal(
          importRedirects(ctx, scope, {
            format: 'json',
            data: Array.from({ length: MAX_REDIRECT_IMPORT + 1 }, (_, i) => ({
              source: `/${i}`,
              destination: '/x',
            })),
          }),
        ),
      ).toMatch(/at most/);
      await expect(importRedirects(ctx, scope, { format: 'json', data: '{' })).rejects.toThrow(
        ValidationError,
      );
      expect((await listRedirects(ctx, scope)).items).toEqual([]);
    });
  });

  describe('slug changes', () => {
    beforeEach(async () => {
      await createContentType(ctx, SYSTEM_CALLER, scope, {
        apiId: 'post',
        name: 'Post',
        displayField: 'title',
        urlPattern: '/blog/{slug}',
        fields: [
          field({ apiId: 'title', type: 'Symbol' }),
          field({ apiId: 'slug', type: 'Slug', position: 1 }),
        ],
      });
      await publishContentType(ctx, scope, 'post');
    });

    const post = async (slug: string) => {
      const { entry } = await createEntry(ctx, scope, {
        contentTypeApiId: 'post',
        fields: { title: { 'en-US': 'T' }, slug: { 'en-US': slug } },
      });
      await publishEntry(ctx, scope, entry.id);
      return entry.id;
    };
    const reslug = async (id: string, slug: string) => {
      await updateEntry(ctx, scope, id, { title: { 'en-US': 'T' }, slug: { 'en-US': slug } });
    };

    it('redirects the old path to the new one when the publish changes the slug', async () => {
      const id = await post('hello');
      expect((await listRedirects(ctx, scope)).items).toEqual([]);
      await reslug(id, 'Hello World');
      // A saved draft moves nothing: only the publish does.
      expect((await listRedirects(ctx, scope)).items).toEqual([]);
      await publishEntry(ctx, scope, id);
      const [made] = (await listRedirects(ctx, scope)).items;
      expect(made).toMatchObject({
        source: '/blog/hello',
        destination: '/blog/hello-world',
        status: 301,
        origin: 'slug',
        entryId: id,
      });
      // It rides with the publish: entry.published purges Delivery, so no extra event.
      expect(changes()).toEqual([]);
    });

    it('keeps no chain and no loop as the slug keeps changing', async () => {
      const id = await post('a');
      await reslug(id, 'b');
      await publishEntry(ctx, scope, id);
      await reslug(id, 'c');
      await publishEntry(ctx, scope, id);
      const pairs = async () =>
        (await listRedirects(ctx, scope)).items.map((r) => `${r.source}→${r.destination}`);
      expect(await pairs()).toEqual(['/blog/a→/blog/c', '/blog/b→/blog/c']);
      // Back to an old slug: the redirect away from it goes.
      await reslug(id, 'a');
      await publishEntry(ctx, scope, id);
      expect(await pairs()).toEqual(['/blog/b→/blog/a', '/blog/c→/blog/a']);
      const report = await analyzeRedirectSet(ctx, scope);
      expect(report.loops).toEqual([]);
      expect(report.chains).toEqual([]);
    });

    it('does nothing without a URL pattern, or on a first publish', async () => {
      await updateContentType(ctx, SYSTEM_CALLER, scope, 'post', { urlPattern: null });
      await publishContentType(ctx, scope, 'post');
      const id = await post('x');
      await reslug(id, 'y');
      await publishEntry(ctx, scope, id);
      expect((await listRedirects(ctx, scope)).items).toEqual([]);
    });

    it('also redirects when a batch publish changes slugs', async () => {
      const id = await post('one');
      await reslug(id, 'two');
      await bulkEntryAction(ctx, scope, 'publish', [id]);
      expect((await listRedirects(ctx, scope)).items.map((r) => r.source)).toEqual(['/blog/one']);
    });

    it('rolls back with a publish that fails', async () => {
      const id = await post('one');
      await reslug(id, 'two');
      // A held source the new redirect can't take: the unit fails, the publish with it.
      const saveMany = store.redirects.saveMany.bind(store.redirects);
      store.redirects.saveMany = async () => {
        throw new ConflictError('taken');
      };
      await expect(publishEntry(ctx, scope, id)).rejects.toBeInstanceOf(ConflictError);
      store.redirects.saveMany = saveMany;
      expect((await listRedirects(ctx, scope)).items).toEqual([]);
      expect(store.allEvents().filter((e) => e.type === 'entry.published')).toHaveLength(1);
    });
  });

  it('travels with an environment snapshot and a clone', async () => {
    await createRedirect(ctx, scope, { source: '/a', destination: '/b', note: 'keep' });
    const snapshot = await exportSnapshot(ctx, scope);
    expect(snapshot.redirects?.map((r) => r.source)).toEqual(['/a']);
    await createEnvironment(ctx, 'site', 'copy');
    await cloneEnvironment(ctx, scope, { spaceId: 'site', environmentId: 'copy' });
    expect(
      (await listRedirects(ctx, { spaceId: 'site', environmentId: 'copy' })).items,
    ).toMatchObject([{ source: '/a', destination: '/b', note: 'keep' }]);

    await createEnvironment(ctx, 'site', 'bad');
    await expect(
      importSnapshot(
        ctx,
        { spaceId: 'site', environmentId: 'bad' },
        {
          ...snapshot,
          redirects: [
            { ...(snapshot.redirects?.[0] as never), source: '/x', destination: '/y' },
            { ...(snapshot.redirects?.[0] as never), id: 'z', source: '/y', destination: '/x' },
          ],
        },
      ),
    ).rejects.toThrow(ValidationError);
  });
});
