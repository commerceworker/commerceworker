import {
  type EntryChange,
  type EntryFields,
  MAX_AUDIT_DETAIL_ENTRIES,
  MAX_AUDIT_DETAIL_SIZE,
  type Principal,
  SCOPES,
  ValidationError,
  WorkflowBuilder,
} from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import {
  FixedClock,
  InMemoryContentStore,
  RecordingWorkflowEngine,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  actingAs,
  type ChangeLog,
  cancelWorkflowRun,
  createAgentReview,
  createChangeLog,
  createContentType,
  createEntry,
  createSpace,
  decideAgentReview,
  duplicateEntry,
  listAuditLog,
  publishContentType,
  recordAudit,
  restoreVersion,
  SYSTEM_CALLER,
  setEntrySeo,
  startWorkflowRun,
  updateEntry,
  withActor,
  withChanges,
} from '../src/index';

const scope = { spaceId: 'blog', environmentId: 'main' };
const SENTINEL = 'SENTINEL_d41d8c';
const editor: Principal = {
  spaceId: 'blog',
  kind: 'user',
  subject: 'editor@example.com',
  scopes: [SCOPES.contentWrite, SCOPES.contentPublish, SCOPES.previewRead],
};

const field = (apiId: string, type: string, position: number, extra: object = {}) => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position,
  ...extra,
});

describe('what a save tells its audit row', () => {
  let base: AppContext;
  let log: ChangeLog;
  let ctx: AppContext;
  let entryId: string;

  const fields = (over: EntryFields = {}): EntryFields => ({
    title: { 'en-US': 'Hello' },
    hero: { 'en-US': { alt: 'A boat' } },
    ...over,
  });
  const only = (): EntryChange => {
    const entries = log.detail()?.entries ?? [];
    expect(entries).toHaveLength(1);
    return entries[0] as EntryChange;
  };

  beforeEach(async () => {
    base = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('id'),
    };
    await createSpace(base, {
      spaceId: 'blog',
      name: 'Blog',
      defaultLocale: 'en-US',
      locales: ['en-US', 'de'],
    });
    await createContentType(base, SYSTEM_CALLER, scope, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [
        field('title', 'Symbol', 0, { localized: true }),
        field('hero', 'Component', 1, { fields: [field('alt', 'Symbol', 0)] }),
        field('data', 'JSON', 2),
        field('seo', 'Seo', 3),
      ],
    } as never);
    await publishContentType(base, scope, 'post');
    entryId = (await createEntry(base, scope, { contentTypeApiId: 'post', fields: fields() })).entry
      .id;
    log = createChangeLog();
    ctx = withChanges(actingAs(base, editor), log);
  });

  it('says which paths a save changed, and the version it made', async () => {
    await updateEntry(
      ctx,
      scope,
      entryId,
      fields({
        title: { 'en-US': 'Hello', de: 'Hallo' },
        hero: { 'en-US': { alt: 'A ship' } },
      }),
    );
    expect(only()).toEqual({
      entryId,
      contentType: 'post',
      kind: 'updated',
      version: 2,
      paths: ['fields.title', 'fields.hero.alt'],
      locales: ['de'],
    });
  });

  it('says a create created, with the fields it was given', async () => {
    const { entry } = await createEntry(ctx, scope, { contentTypeApiId: 'post', fields: fields() });
    expect(only()).toEqual({
      entryId: entry.id,
      contentType: 'post',
      kind: 'created',
      version: 1,
      paths: ['fields.title', 'fields.hero'],
      locales: ['en-US'],
    });
  });

  it('records a save that changed nothing as one, not as no detail', async () => {
    await updateEntry(ctx, scope, entryId, fields());
    expect(only()).toMatchObject({ version: 2, paths: [], locales: [] });
  });

  it('never carries a value: not a field’s, a JSON key or a locale key the space lacks', async () => {
    await updateEntry(
      ctx,
      scope,
      entryId,
      fields({
        title: { 'en-US': SENTINEL, [`x-${SENTINEL}`]: SENTINEL },
        data: { 'en-US': { [SENTINEL]: { secret: SENTINEL } } },
        hero: { 'en-US': { alt: SENTINEL } },
      }),
    );
    const row = await recordAudit(ctx, {
      spaceId: 'blog',
      actor: 'a',
      action: 'b',
      status: 200,
      detail: log.detail(),
    });
    expect(row.detail?.entries[0]?.paths).toEqual([
      'fields.title',
      'fields.hero.alt',
      'fields.data',
    ]);
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
  });

  it('measures what was stored, after the plugin hook rewrote it', async () => {
    const hooked: AppContext = {
      ...ctx,
      hooks: {
        dispatch: async <T>(_hook: string, payload: T) => ({
          payload: { ...payload, fields: fields({ hero: { 'en-US': { alt: 'Rewritten' } } }) },
        }),
      } as never,
    };
    await updateEntry(hooked, scope, entryId, fields());
    expect(only().paths).toEqual(['fields.hero.alt']);
  });

  it('notes nothing for a save that was refused, or lost its commit', async () => {
    await expect(
      updateEntry(ctx, scope, entryId, fields({ unknown: { 'en-US': 1 } })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(log.detail()).toBeUndefined();

    vi.spyOn(base.store.entries, 'saveVersion').mockRejectedValueOnce(
      new TransactionConflictError('lost'),
    );
    await expect(
      updateEntry(ctx, scope, entryId, fields({ title: { 'en-US': 'Lost' } })),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(log.detail()).toBeUndefined();
  });

  it('reaches the use-cases that save on the way to something else', async () => {
    await setEntrySeo(ctx, scope, entryId, { title: SENTINEL });
    expect(only()).toMatchObject({ version: 2, paths: ['fields.seo'] });
    log.clear();

    await restoreVersion(ctx, scope, entryId, 1);
    expect(only()).toMatchObject({ version: 3, paths: ['fields.seo'] });
    log.clear();

    const copy = await duplicateEntry(ctx, scope, entryId);
    expect(only()).toMatchObject({ entryId: copy.entry.id, kind: 'created' });
  });

  it('follows the context through an actor change, as an approved review does', async () => {
    const { id } = await createAgentReview(base, scope, {
      workflow: 'translate',
      entryId,
      proposed: { title: { de: 'Hallo' } },
      notes: [],
    });
    await decideAgentReview(ctx, scope, id, { approve: true, decidedBy: 'usr' });
    expect(only()).toMatchObject({ entryId, paths: ['fields.title'], locales: ['de'] });
  });

  it('reads two saves of one entry as one change', async () => {
    const created = await createEntry(ctx, scope, { contentTypeApiId: 'post', fields: fields() });
    await updateEntry(
      ctx,
      scope,
      created.entry.id,
      fields({ title: { 'en-US': 'Hello', de: 'Hallo' }, data: { 'en-US': { a: 1 } } }),
    );
    expect(only()).toMatchObject({
      kind: 'created',
      version: 2,
      paths: ['fields.title', 'fields.hero', 'fields.data'],
      locales: ['de', 'en-US'],
    });
  });

  it('stops at its entry cap, says so, and runs no more diffs', async () => {
    const summarize = vi.fn(() => ({
      entryId: 'x',
      contentType: 'post',
      kind: 'updated' as const,
      version: 2,
      paths: [],
      locales: [],
    }));
    for (let n = 0; n < MAX_AUDIT_DETAIL_ENTRIES + 5; n++) log.note(`e${n}`, summarize);
    expect(summarize).toHaveBeenCalledTimes(MAX_AUDIT_DETAIL_ENTRIES);
    expect(log.detail()?.entries).toHaveLength(MAX_AUDIT_DETAIL_ENTRIES);
    expect(log.detail()?.truncated).toBe(true);
  });

  it('never fails a save it can’t read, and says the row is partial', () => {
    log.note('e1', () => {
      throw new Error('a diff that broke');
    });
    expect(log.detail()).toEqual({ entries: [], truncated: true });
    log.clear();
    expect(log.detail()).toBeUndefined();
  });

  it('runs no diff when nothing is collecting', async () => {
    const plain = withActor(base, 'usr');
    expect(plain.changes).toBeUndefined();
    await updateEntry(plain, scope, entryId, fields({ title: { 'en-US': 'Quiet' } }));
    expect(log.detail()).toBeUndefined();
  });

  it('caps what a row keeps, with the marker, wherever the detail came from', async () => {
    const paths = Array.from({ length: 500 }, (_, i) => `fields.field${i}`);
    await recordAudit(base, {
      spaceId: 'blog',
      actor: 'a',
      action: 'b',
      status: 200,
      detail: {
        entries: [
          { entryId, contentType: 'post', kind: 'updated', version: 2, paths, locales: [] },
        ],
      },
    });
    const [row] = (await listAuditLog(base, 'blog')).items;
    expect(JSON.stringify(row?.detail).length).toBeLessThanOrEqual(MAX_AUDIT_DETAIL_SIZE);
    expect(row?.detail?.truncated).toBe(true);
  });

  it('adds no key to a row without detail', async () => {
    const row = await recordAudit(base, { spaceId: 'blog', actor: 'a', action: 'b', status: 200 });
    expect('detail' in row).toBe(false);
  });

  describe('a cancelled workflow run', () => {
    const graph = new WorkflowBuilder()
      .n('start', 'trigger.manual', 'Submit')
      .n('done', 'control.end', 'Done')
      .e('start', 'done')
      .graph();

    /** A run with a finished `content.set_fields`, whose compensation restores the title. */
    async function runWithAnEdit(): Promise<{ engine: RecordingWorkflowEngine; runId: string }> {
      const engine = new RecordingWorkflowEngine();
      await base.store.workflowGraphs.publishVersion(
        scope,
        { id: 'wf-1', name: 'Edit', description: '', contentTypes: ['post'], graph },
        { publishedAt: base.clock.now().toISOString() },
      );
      const run = await startWorkflowRun(base, engine, editor, scope, {
        entryId,
        workflowId: 'wf-1',
      });
      const saved = await updateEntry(
        base,
        scope,
        entryId,
        fields({ title: { 'en-US': 'From the run' } }),
      );
      const t = base.clock.now().getTime();
      await base.store.workflowRuns.recordNodeRun(scope, {
        runId: run.id,
        generation: 1,
        nodeId: 'set',
        run: 1,
        nodeType: 'content.set_fields',
        status: 'succeeded',
        summary: null,
        output: {
          locale: 'en-US',
          version: saved.entry.currentVersion,
          prior: { title: 'Hello' },
        },
        error: null,
        startedAt: t,
        endedAt: t + 1,
        durationMs: 1,
      });
      return { engine, runId: run.id };
    }

    const cancelledRow = async () =>
      (await listAuditLog(base, 'blog', { action: 'workflow.run.cancelled' })).items[0];

    it('names what undoing it changed on its own row, with no surface collecting', async () => {
      const { engine, runId } = await runWithAnEdit();
      await cancelWorkflowRun(base, engine, editor, scope, runId);
      expect((await cancelledRow())?.detail?.entries).toMatchObject([
        { entryId, kind: 'updated', paths: ['fields.title'] },
      ]);
    });

    it('hands the same to the surface that is collecting', async () => {
      const { engine, runId } = await runWithAnEdit();
      await cancelWorkflowRun(ctx, engine, editor, scope, runId);
      expect((await cancelledRow())?.detail).toEqual(log.detail());
      expect(only().paths).toEqual(['fields.title']);
    });
  });
});
