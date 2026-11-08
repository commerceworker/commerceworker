import {
  type AppContext,
  addEntryToRelease,
  createContentType,
  createEntry,
  createRelease,
  createSpace,
  createWorkflowDraft,
  listReleases,
  listWorkflows,
  publishContentType,
  publishWorkflowVersion,
  SYSTEM_CALLER,
  saveWorkflowDraft,
} from '@commerceworker/application';
import { WorkflowBuilder } from '@commerceworker/domain';
import type { Clock, IdGenerator } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * What the release and workflow lists add to each row, from grouped queries on D1: a release's
 * member count and a workflow's latest published version. Both take one id per bound parameter,
 * so each test asks for more ids than one statement can bind.
 */
const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const ids: IdGenerator = { newId: () => crypto.randomUUID() };
const store = createD1Store(testDb);
const ctx: AppContext = { store, clock, ids };
const spaceId = `lists-${crypto.randomUUID().slice(0, 8)}`;
const scope = { spaceId, environmentId: 'main' };
const other = { spaceId, environmentId: 'other' };
/** More than the 100 parameters a D1 statement binds. */
const MANY = 130;
const unknownIds = () => Array.from({ length: MANY }, () => crypto.randomUUID());

const startsOn = (type: string) =>
  new WorkflowBuilder()
    .n('start', type, 'Start')
    .n('done', 'control.end', 'Done')
    .e('start', 'done')
    .graph();

describe('list summaries on D1', () => {
  it('counts each release’s members in one grouped query, past the parameter cap', async () => {
    await createSpace(ctx, { spaceId, name: 'Lists', defaultLocale: 'en-US', locales: ['en-US'] });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
      ],
    });
    await publishContentType(ctx, scope, 'page');
    const entries = await Promise.all(
      ['A', 'B', 'C'].map((title) =>
        createEntry(ctx, scope, {
          contentTypeApiId: 'page',
          fields: { title: { 'en-US': title } },
        }),
      ),
    );
    const three = await createRelease(ctx, scope, { title: 'Three' });
    const one = await createRelease(ctx, scope, { title: 'One' });
    await createRelease(ctx, scope, { title: 'None' });
    for (const e of entries)
      await addEntryToRelease(ctx, scope, three.id, { entityId: e.entry.id });
    await addEntryToRelease(ctx, scope, one.id, { entityId: entries[0]?.entry.id ?? '' });

    const counts = Object.fromEntries(
      (await listReleases(ctx, scope)).map((r) => [r.title, r.itemCount]),
    );
    expect(counts).toEqual({ Three: 3, One: 1, None: 0 });

    // The real ids last, after a statement's worth of unknown ones: every chunk is read.
    const many = await store.releases.countItems(scope, [...unknownIds(), three.id, one.id]);
    expect(Object.fromEntries(many)).toEqual({ [three.id]: 3, [one.id]: 1 });
    // Another environment's view of the same ids counts nothing.
    expect((await store.releases.countItems(other, [three.id, one.id])).size).toBe(0);
  });

  it('reads each workflow’s latest published version, past the parameter cap', async () => {
    const make = async (name: string, type: string, contentTypes: string[]) => {
      const { workflow } = await createWorkflowDraft(ctx, scope, {
        name,
        contentTypes,
        graph: startsOn(type),
      });
      return workflow.id;
    };
    const twice = await make('Twice', 'trigger.manual', ['page']);
    await publishWorkflowVersion(ctx, scope, twice);
    // v2 starts on publish; a later draft back to manual is not published.
    await saveWorkflowDraft(ctx, scope, twice, { graph: startsOn('trigger.entry_published') });
    await publishWorkflowVersion(ctx, scope, twice);
    await saveWorkflowDraft(ctx, scope, twice, { graph: startsOn('trigger.manual') });
    const announce = await make('Announce', 'trigger.entry_published', []);
    await publishWorkflowVersion(ctx, scope, announce);
    const draft = await make('Draft', 'trigger.manual', ['page']);

    const latest = await store.workflowGraphs.listLatestVersions(scope, [
      ...unknownIds(),
      twice,
      announce,
      draft,
    ]);
    expect(
      Object.fromEntries(latest.map((v) => [v.id, [v.version, v.graph.nodes[0]?.type]])),
    ).toEqual({
      [twice]: [2, 'trigger.entry_published'],
      [announce]: [1, 'trigger.entry_published'],
    });
    expect(await store.workflowGraphs.listLatestVersions(other, [twice, announce])).toEqual([]);

    const listed = new Map((await listWorkflows(ctx, scope)).map((w) => [w.id, w]));
    expect(listed.get(twice)).toMatchObject({
      publishedTrigger: { type: 'trigger.entry_published', label: 'Entry published' },
      startsAlongside: [announce],
    });
    expect(listed.get(announce)?.startsAlongside).toEqual([twice]);
    expect(listed.get(draft)).toMatchObject({ publishedTrigger: null, startsAlongside: null });
  });
});
