import type { AppContext } from '@commerceworker/application';
import {
  listAgentRuns,
  listAssets,
  listAuditLog,
  listPreviewEntries,
  listReleases,
  listScheduledActions,
  listTags,
  listWebhooks,
  listWorkflows,
} from '@commerceworker/application';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { type SeedConfig, seedDev, volumes } from '../src/index';

const config: SeedConfig = {
  spaceId: 'space-1',
  environmentId: 'main',
  defaultLocale: 'en-US',
  locales: ['en-US', 'de-DE'],
  cmaKey: 'dev-cma-key',
  cdaKey: 'dev-cda-key',
  cpaKey: 'dev-cpa-key',
};
const scope = { spaceId: config.spaceId, environmentId: config.environmentId };

function makeContext(): AppContext {
  const store = new InMemoryContentStore();
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('s') };
}

// Every test here seeds a corpus through the real use-cases — hundreds to
// thousands of entries — so they are legitimately slow, and the sibling tests
// were running at 2.4s against vitest 4's 5s default: a margin thin enough to
// flip on a loaded runner. Scoped to this suite rather than raised globally,
// because the shorter default is a useful signal everywhere else and a
// project-wide bump would hide the next slow test.
describe('seedDev', { timeout: 60_000 }, () => {
  it('seeds every capability surface against a fresh store', async () => {
    const ctx = makeContext();
    await seedDev(ctx, config, { blob: new FakeBlobStore() });

    const vol = volumes(1);
    const articles = await listPreviewEntries(ctx, scope, {
      contentTypeApiId: 'article',
      locale: 'en-US',
      limit: vol.articles + 10,
    });
    expect(articles.length).toBe(vol.articles);
    // Status mix: drafts, changed, and published all present.
    const statuses = new Set(articles.map((a) => a.status));
    expect(statuses).toContain('draft');
    expect(statuses).toContain('changed');
    expect(statuses).toContain('published');

    expect((await listAssets(ctx, scope)).items.length).toBeGreaterThan(0);
    expect((await listReleases(ctx, scope)).map((r) => r.title)).toContain('Autumn launch');
    expect((await listWorkflows(ctx, scope)).length).toBe(2);
    expect((await listWebhooks(ctx, scope)).length).toBe(3);
    expect((await listScheduledActions(ctx, scope)).length).toBeGreaterThan(0);
    expect((await listAgentRuns(ctx, scope, {})).length).toBeGreaterThan(0);
    expect((await listAuditLog(ctx, config.spaceId)).items.length).toBeGreaterThan(0);
    // The completion marker lands last.
    expect((await listTags(ctx, scope)).map((t) => t.name)).toContain('demo-seed-v3');
    // All three scheduled actions: release publish, entry publish, entry unpublish.
    expect((await listScheduledActions(ctx, scope)).length).toBe(3);
  });

  it('is idempotent — a second run creates nothing new', async () => {
    const ctx = makeContext();
    const blob = new FakeBlobStore();
    await seedDev(ctx, config, { blob });

    const before = {
      entries: (await listPreviewEntries(ctx, scope, { locale: 'en-US', limit: 10_000 })).length,
      tags: (await listTags(ctx, scope)).length,
      releases: (await listReleases(ctx, scope)).length,
      runs: (await listAgentRuns(ctx, scope, {})).length,
    };
    await seedDev(ctx, config, { blob });
    const after = {
      entries: (await listPreviewEntries(ctx, scope, { locale: 'en-US', limit: 10_000 })).length,
      tags: (await listTags(ctx, scope)).length,
      releases: (await listReleases(ctx, scope)).length,
      runs: (await listAgentRuns(ctx, scope, {})).length,
    };
    expect(after).toEqual(before);
  });

  it('stores a real file for every seeded image and document, and none for videos', async () => {
    const ctx = makeContext();
    const blob = new FakeBlobStore();
    await seedDev(ctx, config, { blob });
    const keys = blob.keys();
    const png = keys.filter((k) => k.endsWith('.png'));
    const pdf = keys.filter((k) => k.endsWith('.pdf'));
    expect(png.length).toBeGreaterThan(0);
    expect(pdf.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.endsWith('.mp4'))).toBe(false);
    // PNG signature and PDF header: the bytes are the files their names say.
    expect([...(blob.bytes(png[0] as string) ?? []).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(await blob.get(pdf[0] as string)).toMatch(/^%PDF-1\.4/);
  });

  it('scales the generated corpus linearly', async () => {
    const ctx = makeContext();
    await seedDev(ctx, { ...config, scale: 2 }, { blob: new FakeBlobStore() });
    const articles = await listPreviewEntries(ctx, scope, {
      contentTypeApiId: 'article',
      locale: 'en-US',
      limit: 10_000,
    });
    expect(articles.length).toBe(volumes(2).articles);
  });
});
