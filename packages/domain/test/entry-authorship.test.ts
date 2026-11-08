import { describe, expect, it } from 'vitest';
import {
  agentActor,
  type Entry,
  entrySysOf,
  pluginActor,
  publish,
  runEntryQuery,
  stampChanged,
  stampCreated,
  stampPublished,
  unpublish,
  workflowActor,
} from '../src/index';

const draft: Entry = {
  id: 'e1',
  contentTypeApiId: 'post',
  status: 'draft',
  currentVersion: 1,
  publishedVersion: null,
};

describe('entry authorship', () => {
  it('credits a new entry to its creator, unless it brings its own', () => {
    expect(stampCreated(draft, 'ada', '2026-01-01T00:00:00.000Z')).toMatchObject({
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'ada',
      updatedBy: 'ada',
      firstPublishedAt: null,
    });
    const copied = { ...draft, createdAt: '2025-01-01T00:00:00.000Z', createdBy: null };
    expect(stampCreated(copied, 'grace', '2026-01-01T00:00:00.000Z')).toMatchObject({
      createdAt: '2025-01-01T00:00:00.000Z',
      createdBy: null,
      updatedBy: 'grace',
    });
  });

  it('sets the first publish once and keeps it through unpublish', () => {
    const created = stampCreated(draft, 'ada', '2026-01-01T00:00:00.000Z');
    const live = stampPublished(created, publish(created), 'grace', '2026-01-02T00:00:00.000Z');
    expect(live).toMatchObject({
      updatedBy: 'grace',
      firstPublishedAt: '2026-01-02T00:00:00.000Z',
    });
    const pulled = stampChanged(unpublish(live), 'ada');
    const again = stampPublished(pulled, publish(pulled), 'ada', '2026-01-03T00:00:00.000Z');
    expect(again.firstPublishedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('leaves the first publish unknown for an entry already live without one', () => {
    const legacy: Entry = { ...draft, status: 'published', publishedVersion: 1 };
    expect(
      stampPublished(legacy, publish(legacy), 'ada', '2026-01-02T00:00:00.000Z'),
    ).toMatchObject({ firstPublishedAt: null });
  });

  it('names the actors that are not a principal', () => {
    expect([agentActor('enrich'), workflowActor('wf-1'), pluginActor('p-1')]).toEqual([
      'agent:enrich',
      'workflow:wf-1',
      'plugin:p-1',
    ]);
  });

  it('filters and sorts on the sys authorship fields, unknown matching no comparison', () => {
    const rows = [
      { entry: stampCreated(draft, 'ada', '2026-01-02T00:00:00.000Z'), fields: {} },
      {
        entry: stampCreated({ ...draft, id: 'e2' }, 'grace', '2026-01-01T00:00:00.000Z'),
        fields: {},
      },
      { entry: { ...draft, id: 'e3', createdBy: null }, fields: {} },
    ];
    const run = (q: Parameters<typeof runEntryQuery>[1]) =>
      runEntryQuery(
        rows,
        q,
        (r) => r.fields,
        (r) => entrySysOf(r.entry, undefined),
      ).map((r) => r.entry.id);
    expect(run({ filters: [{ field: 'sys.createdBy', op: 'eq', value: 'ada' }] })).toEqual(['e1']);
    expect(run({ filters: [{ field: 'sys.createdBy', op: 'exists', value: false }] })).toEqual([
      'e3',
    ]);
    expect(
      run({
        filters: [{ field: 'sys.createdAt', op: 'exists', value: true }],
        order: [{ field: 'sys.createdAt', direction: 'asc' }],
      }),
    ).toEqual(['e2', 'e1']);
  });
});
