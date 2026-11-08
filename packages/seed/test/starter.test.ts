import type { AppContext } from '@commerceworker/application';
import {
  createContentType,
  createSpace,
  getContentType,
  listAgentReviews,
  listAgentRuns,
  listAgentSchedules,
  listAIActions,
  listApiKeys,
  listAssets,
  listAuditLog,
  listComments,
  listContentTypes,
  listFunctions,
  listPreviewEntries,
  listReleases,
  listScheduledActions,
  listSchemes,
  listTags,
  listTasks,
  listWebhooks,
  listWorkflows,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createSpaceWithStarter, installStarter, STARTER_VOLUMES } from '../src/index';

const scope = { spaceId: 'acme', environmentId: 'main' };
const starterEntries = Object.values(STARTER_VOLUMES).reduce((a, b) => a + b, 0) + 3; // + curated pages

function makeContext(): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('st'),
  };
}

async function snapshot(ctx: AppContext) {
  return {
    types: (await listContentTypes(ctx, scope)).length,
    entries: (await listPreviewEntries(ctx, scope, { locale: 'en-US', limit: 1000 })).length,
    assets: (await listAssets(ctx, scope, { limit: 1000 })).items.length,
    tags: (await listTags(ctx, scope)).length,
    schemes: (await listSchemes(ctx, scope)).length,
    releases: (await listReleases(ctx, scope)).length,
  };
}

describe('installing the starter', { timeout: 30_000 }, () => {
  it('installs the content model, a small corpus, taxonomy, assets and one release', async () => {
    const ctx = makeContext();
    const blob = new FakeBlobStore();
    const created = await createSpaceWithStarter(
      ctx,
      { spaceId: 'acme', name: 'Acme', defaultLocale: 'en-US', starter: 'sample' },
      { blob },
    );

    expect(created.starter).toBe('sample');
    const types = (await listContentTypes(ctx, scope)).map((t) => t.apiId).sort();
    expect(types).toEqual(
      ['article', 'author', 'category', 'event', 'landingPage', 'page', 'product', 'recipe'].sort(),
    );
    const entries = await listPreviewEntries(ctx, scope, { locale: 'en-US', limit: 1000 });
    expect(entries.length).toBe(starterEntries);
    expect(new Set(entries.map((e) => e.status))).toEqual(
      new Set(['draft', 'changed', 'published']),
    );
    expect(created.installed).toMatchObject({ contentTypes: 8, entries: starterEntries });

    // Landing pages are built from blocks, each keyed by the server on create.
    const landing = entries.find((e) => e.contentType === 'landingPage');
    const blocks = (landing?.fields.blocks as Record<string, unknown> | undefined)?.['en-US'] as
      | { _type: string; _key?: string }[]
      | undefined;
    expect(blocks?.map((b) => b._type)).toEqual(['hero', 'richText', 'callToAction']);
    expect(blocks?.every((b) => typeof b._key === 'string')).toBe(true);

    // Images and documents with real bytes, never a video with nothing behind it.
    const assets = (await listAssets(ctx, scope, { limit: 100 })).items;
    expect(assets.length).toBe(8);
    expect(blob.keys().length).toBe(8);
    expect(assets.some((a) => a.file?.contentType === 'video/mp4')).toBe(false);

    expect((await listTags(ctx, scope)).length).toBe(12);
    expect((await listSchemes(ctx, scope)).length).toBe(2);
    expect((await listReleases(ctx, scope)).map((r) => r.title)).toEqual(['First release']);
  });

  it('installs nothing a real space should not start with', async () => {
    const ctx = makeContext();
    await createSpaceWithStarter(
      ctx,
      { spaceId: 'acme', name: 'Acme', defaultLocale: 'en-US', starter: 'sample' },
      { blob: new FakeBlobStore() },
    );

    expect(await listApiKeys(ctx, 'acme')).toEqual([]);
    expect(await listWebhooks(ctx, scope)).toEqual([]);
    expect(await listFunctions(ctx, scope)).toEqual([]);
    expect(await listAIActions(ctx, scope)).toEqual([]);
    expect(await listWorkflows(ctx, scope)).toEqual([]);
    expect(await listScheduledActions(ctx, scope)).toEqual([]);
    expect(await listAgentRuns(ctx, scope, {})).toEqual([]);
    expect(await listAgentSchedules(ctx, scope)).toEqual([]);
    expect(await listAgentReviews(ctx, scope)).toEqual([]);
    expect((await listAuditLog(ctx, 'acme')).items).toEqual([]);
    const entries = await listPreviewEntries(ctx, scope, { locale: 'en-US', limit: 1000 });
    for (const e of entries) {
      expect(await listComments(ctx, scope, e.id)).toEqual([]);
      expect(await listTasks(ctx, scope, e.id)).toEqual([]);
    }
    // No marker tag: the taxonomy is the twelve sample tags and nothing else.
    expect((await listTags(ctx, scope)).some((t) => t.name.startsWith('demo-seed'))).toBe(false);
  });

  it('is idempotent: a second run, or a repeated create, adds nothing', async () => {
    const ctx = makeContext();
    const blob = new FakeBlobStore();
    const input = {
      spaceId: 'acme',
      name: 'Acme',
      defaultLocale: 'en-US',
      starter: 'sample',
    } as const;
    await createSpaceWithStarter(ctx, input, { blob });
    const before = await snapshot(ctx);
    const versionsBefore = (await getContentType(ctx, scope, 'article')).version;

    await installStarter(ctx, scope, { blob });
    await createSpaceWithStarter(ctx, input, { blob });

    expect(await snapshot(ctx)).toEqual(before);
    // The content model was left alone, not re-saved.
    expect((await getContentType(ctx, scope, 'article')).version).toBe(versionsBefore);
    expect(blob.keys().length).toBe(8);
  });

  it('finishes an install that failed part-way, without duplicating what it made', async () => {
    const ctx = makeContext();
    await createSpace(ctx, { spaceId: 'acme', name: 'Acme', defaultLocale: 'en-US' });
    // A store that fails the 30th entry write: the first run stops in the middle of the corpus.
    const create = ctx.store.entries.create.bind(ctx.store.entries);
    let writes = 0;
    ctx.store.entries.create = (async (...args: Parameters<typeof create>) => {
      writes += 1;
      if (writes === 30) throw new Error('D1 went away');
      return create(...args);
    }) as typeof create;
    await expect(installStarter(ctx, scope)).rejects.toThrow('D1 went away');
    const partial = (await listPreviewEntries(ctx, scope, { locale: 'en-US', limit: 1000 })).length;
    expect(partial).toBe(29);

    await installStarter(ctx, scope);
    expect((await listPreviewEntries(ctx, scope, { locale: 'en-US', limit: 1000 })).length).toBe(
      starterEntries,
    );
  });

  it('leaves an existing content type of the same apiId untouched', async () => {
    const ctx = makeContext();
    await createSpace(ctx, { spaceId: 'acme', name: 'Acme', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'author',
      name: 'Writer',
      displayField: 'name',
      fields: [
        {
          apiId: 'name',
          name: 'Name',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'role',
          name: 'Role',
          type: 'Symbol',
          localized: false,
          required: false,
          position: 1,
        },
        { apiId: 'bio', name: 'Bio', type: 'Text', localized: true, required: false, position: 2 },
      ],
    });
    await installStarter(ctx, scope);
    expect((await getContentType(ctx, scope, 'author')).name).toBe('Writer');
  });

  it('creates an empty space by default, and keeps spaces apart', async () => {
    const ctx = makeContext();
    const created = await createSpaceWithStarter(ctx, {
      spaceId: 'blank',
      name: 'Blank',
      defaultLocale: 'en-US',
    });
    expect(created.starter).toBe('empty');
    expect(created.installed).toBeUndefined();
    const blank = { spaceId: 'blank', environmentId: 'main' };
    expect(await listContentTypes(ctx, blank)).toEqual([]);

    await createSpaceWithStarter(ctx, {
      spaceId: 'acme',
      name: 'Acme',
      defaultLocale: 'en-US',
      starter: 'sample',
    });
    expect(await listContentTypes(ctx, blank)).toEqual([]);
    expect(await listPreviewEntries(ctx, blank, { locale: 'en-US' })).toEqual([]);
  });

  it("writes in the space's own default locale", async () => {
    const ctx = makeContext();
    await createSpaceWithStarter(ctx, {
      spaceId: 'acme',
      name: 'Acme',
      defaultLocale: 'fr-FR',
      starter: 'sample',
    });
    const [first] = await listPreviewEntries(ctx, scope, {
      contentTypeApiId: 'category',
      locale: 'fr-FR',
      limit: 1,
    });
    expect(Object.keys((first?.fields.name ?? {}) as object)).toEqual(['fr-FR']);
  });
});
