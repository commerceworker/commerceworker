import type { AppContext } from '@commerceworker/application';
import {
  createSpace,
  getLocaleSettings,
  listAssets,
  listContentTypes,
  listMenus,
  listPreviewEntries,
  listReleases,
  listRoles,
  listWorkflows,
  listWorkflowTasks,
} from '@commerceworker/application';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { ENTERPRISE_PHASES } from '../src/enterprise/phases';
import { enterpriseSpaceInput, installEnterpriseNow } from '../src/index';

const scope = { spaceId: 'aldermoor', environmentId: 'main' };

async function installed(defaultLocale = 'en-US') {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('e'),
  };
  const blob = new FakeBlobStore();
  await createSpace(
    ctx,
    enterpriseSpaceInput({ spaceId: scope.spaceId, name: 'Aldermoor', defaultLocale }),
  );
  await installEnterpriseNow(ctx, scope, { blob });
  return { ctx, blob };
}

async function countEntries(ctx: AppContext) {
  const rows = await listPreviewEntries(ctx, scope, { limit: 2000 });
  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.contentType] = (byType[r.contentType] ?? 0) + 1;
  return { total: rows.length, byType, rows };
}

describe('the enterprise starter dataset', { timeout: 120_000 }, () => {
  it('installs every phase into a fresh space, and a second run adds nothing', async () => {
    const { ctx, blob } = await installed();
    const first = await countEntries(ctx);
    expect(first.total).toBeGreaterThan(250);
    expect((await listContentTypes(ctx, scope)).length).toBe(21);
    for (const type of [
      'insight',
      'caseStudy',
      'pressRelease',
      'event',
      'person',
      'office',
      'service',
      'industry',
      'legalPage',
      'homePage',
      'siteSettings',
    ]) {
      expect(first.byType[type], type).toBeGreaterThan(0);
    }
    const statuses = new Set(first.rows.map((r) => r.status));
    for (const s of ['draft', 'published', 'changed']) expect(statuses).toContain(s);

    for (const phase of ENTERPRISE_PHASES) {
      await import('../src/enterprise/install').then((m) =>
        m.runEnterprisePhase(ctx, scope, phase.id, { blob }),
      );
    }
    expect((await countEntries(ctx)).total).toBe(first.total);
    expect((await listAssets(ctx, scope, { limit: 200 })).items.length).toBeGreaterThan(30);
  });

  it('sets up the team, workflows, approvals, releases and menus', async () => {
    const { ctx } = await installed();
    expect((await listRoles(ctx, scope.spaceId)).map((r) => r.name)).toContain('Translator');
    expect((await listWorkflows(ctx, scope)).length).toBeGreaterThanOrEqual(8);
    expect((await listWorkflowTasks(ctx, scope)).length).toBeGreaterThan(5);
    expect((await listReleases(ctx, scope)).map((r) => r.title)).toContain(
      'CEO Outlook 2027 launch',
    );
    expect((await listMenus(ctx, scope)).map((m) => m.handle)).toContain('main-de');
    const locales = await getLocaleSettings(ctx, scope);
    expect(locales.localeSettings['ar-AE']?.direction).toBe('rtl');
    expect(locales.localeSettings['it-IT']?.delivered).toBe(false);
  });

  it('installs into a space whose default locale is not English', async () => {
    const { ctx } = await installed('de-DE');
    const home = await listPreviewEntries(ctx, scope, {
      contentTypeApiId: 'service',
      locale: 'de-DE',
      limit: 50,
    });
    const names = home.map((r) => (r.fields.name as Record<string, string>)['de-DE']);
    expect(names).toContain('Wirtschaftsprüfung');
  });
});
