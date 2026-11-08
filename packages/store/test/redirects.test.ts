import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createRedirect,
  createSpace,
  getContentType,
  importRedirects,
  listDeliveredRedirects,
  listRedirects,
  publishEntry,
  resolveRedirect,
  SYSTEM_CALLER,
  updateEntry,
} from '@commerceworker/application';
import { ConflictError, type FieldDefinition, type Redirect } from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Redirects on D1 (0017_redirects): the unique source per locale, the set's compare-and-set that
 * refuses a lost race at commit, imports and lookups past the 100-parameter cap, a slug change
 * written with its publish, the content type's URL pattern, and the tables cleared with their
 * environment. Each test makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const AT = '2026-01-01T00:00:00.000Z';

async function harness() {
  const clock = new FixedClock(new Date(AT));
  const ctx: AppContext = { store, clock, ids: { newId: uid } };
  const spaceId = `redir-${uid()}`;
  await createSpace(ctx, {
    spaceId,
    name: 'Redirects',
    defaultLocale: 'en-US',
    locales: ['en-US', 'de'],
  });
  return { ctx, clock, spaceId, scope: { spaceId, environmentId: 'main' } };
}

const row = (source: string, destination: string, over: Partial<Redirect> = {}): Redirect => ({
  id: uid(),
  source,
  destination,
  status: 301,
  enabled: true,
  origin: 'manual',
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

describe('redirects on D1', () => {
  it('stores every field and reads it back, in source order', async () => {
    const { ctx, scope } = await harness();
    const { redirect } = await createRedirect(ctx, scope, {
      source: '/z',
      destination: 'https://example.com/z?q=1',
      status: 308,
      locale: 'de',
      enabled: false,
      note: 'Moved off-site',
    });
    await createRedirect(ctx, scope, { source: '/a', destination: '/b' });
    const all = await store.redirects.all(scope);
    expect(all.map((r) => r.source)).toEqual(['/a', '/z']);
    expect(all[1]).toEqual(redirect);
    expect((await listDeliveredRedirects(ctx, scope)).map((r) => r.source)).toEqual(['/a']);
    expect(await store.redirects.state(scope)).toEqual({ revision: 2, count: 2 });
  });

  it('holds one redirect per source per locale', async () => {
    const { scope } = await harness();
    await store.redirects.saveMany(scope, [row('/a', '/b'), row('/a', '/c', { locale: 'de' })]);
    await expect(store.redirects.saveMany(scope, [row('/a', '/d')])).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('refuses a lost race at commit, and moves on unconditionally for a publish', async () => {
    const { scope } = await harness();
    await store.redirects.advance(scope, 0);
    await expect(
      store.withTransaction(async (tx) => {
        await tx.redirects.saveMany(scope, [row('/a', '/b')]);
        await tx.redirects.advance(scope, 0);
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(await store.redirects.state(scope)).toEqual({ revision: 1, count: 0 });
    await store.withTransaction(async (tx) => {
      await tx.redirects.advance(scope);
    });
    await expect(store.redirects.advance(scope, 1)).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
    expect((await store.redirects.state(scope)).revision).toBe(2);
  });

  it('imports and looks up past the 100-parameter cap', async () => {
    const { ctx, scope } = await harness();
    const data = Array.from({ length: 250 }, (_, i) => ({
      source: `/old/${i}`,
      destination: `/new/${i}`,
      note: `n${i}`,
    }));
    expect(await importRedirects(ctx, scope, { format: 'json', data })).toMatchObject({
      created: 250,
    });
    const paths = Array.from({ length: 150 }, (_, i) => `/old/${i}`);
    expect(await store.redirects.involving(scope, paths)).toHaveLength(150);
    const ids = (await store.redirects.all(scope)).map((r) => r.id);
    await store.redirects.removeMany(scope, ids.slice(0, 120));
    expect((await store.redirects.state(scope)).count).toBe(130);
    expect((await resolveRedirect(ctx, scope, '/old/249'))?.location).toBe('/new/249');
  });

  it('pages and searches the list by source', async () => {
    const { ctx, scope } = await harness();
    await importRedirects(ctx, scope, {
      format: 'csv',
      data: 'source,destination,note\n/c,/x,\n/a,/x,Spring SALE\n/b,/y,\n',
    });
    const first = await listRedirects(ctx, scope, { limit: 2 });
    expect(first.items.map((r) => r.source)).toEqual(['/a', '/b']);
    const second = await listRedirects(ctx, scope, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((r) => r.source)).toEqual(['/c']);
    expect(second.nextCursor).toBeUndefined();
    expect((await listRedirects(ctx, scope, { q: 'sale' })).items.map((r) => r.source)).toEqual([
      '/a',
    ]);
    expect((await listRedirects(ctx, scope, { q: '/y' })).items.map((r) => r.source)).toEqual([
      '/b',
    ]);
  });

  it('keeps each environment’s set to itself', async () => {
    const { ctx, spaceId, scope } = await harness();
    await createEnvironment(ctx, spaceId, 'staging');
    const staging = { spaceId, environmentId: 'staging' };
    await createRedirect(ctx, scope, { source: '/a', destination: '/b' });
    await createRedirect(ctx, staging, { source: '/a', destination: '/c' });
    expect((await store.redirects.all(staging)).map((r) => r.destination)).toEqual(['/c']);
    expect(await store.redirects.state(staging)).toEqual({ revision: 1, count: 1 });
  });

  it('stores a URL pattern and writes a slug change’s redirect with the publish', async () => {
    const { ctx, scope } = await harness();
    const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
      ({
        name: over.apiId,
        localized: false,
        required: false,
        position: 0,
        ...over,
      }) as FieldDefinition;
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'page',
      name: 'Page',
      displayField: 'slug',
      urlPattern: '/{locale}/{slug}',
      fields: [field({ apiId: 'slug', type: 'Slug', localized: true })],
    });
    expect((await getContentType(ctx, scope, 'page')).urlPattern).toBe('/{locale}/{slug}');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { slug: { 'en-US': 'about', de: 'ueber' } },
    });
    await publishEntry(ctx, scope, entry.id);
    // Something already pointed at the old English path: it follows the move.
    await createRedirect(ctx, scope, { source: '/en-US/info', destination: '/en-US/about' });
    await updateEntry(ctx, scope, entry.id, { slug: { 'en-US': 'about-us', de: 'ueber' } });
    await publishEntry(ctx, scope, entry.id);
    const all = await store.redirects.all(scope);
    expect(all.map((r) => [r.source, r.destination, r.locale ?? null, r.origin])).toEqual([
      ['/en-US/about', '/en-US/about-us', 'en-US', 'slug'],
      ['/en-US/info', '/en-US/about-us', null, 'manual'],
    ]);
  });

  it('clears both tables with their environment', async () => {
    const { ctx, clock, spaceId } = await harness();
    const env = `gone-${uid().slice(0, 8)}`;
    await createEnvironment(ctx, spaceId, env);
    await createRedirect(ctx, { spaceId, environmentId: env }, { source: '/a', destination: '/b' });
    await store.spaces.deleteEnvironment(spaceId, env, [], {
      id: uid(),
      spaceId,
      environmentId: env,
      at: clock.now().toISOString(),
      actor: 'test',
      action: 'environment.deleted',
      status: 200,
    });
    while ((await store.spaces.purgeEnvironmentStep(spaceId, env, 500, clock.now())) > 0) {}
    for (const table of ['redirects', 'redirect_sets']) {
      const n = await testDb
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE space_id = ? AND environment_id = ?`)
        .bind(spaceId, env)
        .first<{ n: number }>();
      expect(n?.n, table).toBe(0);
    }
  });
});
