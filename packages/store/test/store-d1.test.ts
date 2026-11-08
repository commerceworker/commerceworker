import type { AppContext } from '@commerceworker/application';
import {
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  deleteEnvironment,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  startWorkflowRun,
} from '@commerceworker/application';
import {
  ConflictError,
  type DomainEvent,
  type Principal,
  SCOPES,
  WorkflowBuilder,
  type WorkflowRun,
} from '@commerceworker/domain';
import { type Clock, type IdGenerator, TransactionConflictError } from '@commerceworker/ports';
import { RecordingWorkflowEngine } from '@commerceworker/test-kit';
import { countingD1 } from '@commerceworker/test-kit/d1';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * What the D1 store guarantees beyond the port's basics: `withTransaction` as a unit of work (atomic
 * commit, compare-and-set guards that fail the whole unit), the lease-claimed outbox, and every
 * caller-sized list split under D1's 100-bound-parameter cap.
 */
const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const uid = () => crypto.randomUUID();
const ids: IdGenerator = { newId: uid };

const store = createD1Store(testDb);
const ctx: AppContext = { store, clock, ids };
const spaceId = `uow-${uid()}`;
const scope = { spaceId, environmentId: 'main' };

const event = (n: string): DomainEvent => ({
  id: `evt-${uid()}`,
  type: 'entry.published',
  scope,
  occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, Number(n))).toISOString(),
  entryId: `lease-${n}`,
  contentTypeApiId: 'article',
  version: 1,
  fields: {},
});

const settle = async <T>(ps: Promise<T>[]) => {
  const results = await Promise.allSettled(ps);
  return {
    ok: results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<T>[],
    failed: results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[],
  };
};

beforeAll(async () => {
  await createSpace(ctx, { spaceId, name: 'UoW', defaultLocale: 'en-US', locales: ['en-US'] });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
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
  await publishContentType(ctx, scope, 'article');
});

describe('withTransaction (unit of work)', () => {
  it('commits every write at once and writes nothing when fn throws', async () => {
    const [a, b] = [`tag-${uid()}`, `tag-${uid()}`];
    await store.withTransaction(async (tx) => {
      await tx.taxonomy.createTag(scope, {
        id: a,
        name: 'A',
        slug: 'a',
        description: null,
        labels: {},
      });
      await tx.taxonomy.createTag(scope, {
        id: b,
        name: 'B',
        slug: 'b',
        description: null,
        labels: {},
      });
      // Reads inside the unit see committed state only.
      expect(await tx.taxonomy.getTag(scope, a)).toBeNull();
    });
    expect(await store.taxonomy.getTag(scope, a)).toMatchObject({ name: 'A' });
    expect(await store.taxonomy.getTag(scope, b)).toMatchObject({ name: 'B' });

    const c = `tag-${uid()}`;
    await expect(
      store.withTransaction(async (tx) => {
        await tx.taxonomy.createTag(scope, {
          id: c,
          name: 'C',
          slug: 'c',
          description: null,
          labels: {},
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.taxonomy.getTag(scope, c)).toBeNull();
  });

  it('refuses returning compare-and-set methods that have no in-unit answer', async () => {
    await expect(
      store.withTransaction((tx) =>
        tx.bulkJobs.claimChunk(scope, 'j', 'c', { now: new Date(), staleBefore: new Date() }),
      ),
    ).rejects.toThrow(/cannot run inside withTransaction/);
    await expect(
      store.withTransaction((tx) => tx.outbox.deleteRelayedBefore(new Date(), 1)),
    ).rejects.toThrow(/cannot run inside withTransaction/);
  });

  it('two units saving the same run revision: exactly one commits', async () => {
    const principal: Principal = {
      spaceId,
      kind: 'user',
      subject: 'racer@example.com',
      scopes: [SCOPES.contentWrite, SCOPES.contentPublish],
    };
    const graph = new WorkflowBuilder()
      .n('start', 'trigger.manual', 'Submit')
      .n('done', 'control.end', 'Done')
      .e('start', 'done')
      .graph();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Race' } },
    });
    const v = await store.workflowGraphs.publishVersion(
      scope,
      { id: uid(), name: 'Race', description: '', contentTypes: [], graph },
      { publishedAt: clock.now().toISOString() },
    );
    const run = await startWorkflowRun(ctx, new RecordingWorkflowEngine(), principal, scope, {
      entryId: entry.id,
      workflowId: v.id,
    });
    const cur = (await store.workflowRuns.get(scope, run.id)) as WorkflowRun;

    const save = (label: string) =>
      store.withTransaction(async (tx) => {
        const saved = await tx.workflowRuns.save(
          scope,
          { ...cur, rev: cur.rev + 1, vars: { winner: label } },
          cur.rev,
        );
        await tx.outbox.append({ ...event('1'), id: `evt-${label}-${uid()}` });
        return saved;
      });
    const { ok, failed } = await settle([save('a'), save('b')]);
    expect(ok).toHaveLength(1);
    expect(ok[0]?.value).toBe(true);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(TransactionConflictError);

    const after = (await store.workflowRuns.get(scope, run.id)) as WorkflowRun;
    expect(after.rev).toBe(cur.rev + 1);
    // Outside a unit the same stale CAS reports false instead of throwing.
    expect(await store.workflowRuns.save(scope, { ...after, rev: 99 }, cur.rev)).toBe(false);
  });

  it('two units finalizing the same bulk job: one wins, the other conflicts', async () => {
    const jobId = uid();
    await store.bulkJobs.createJob(scope, {
      id: jobId,
      action: 'publish',
      status: 'running',
      totalItems: 1,
      totalChunks: 1,
      completedChunks: 1,
      succeeded: 1,
      failed: 0,
      createdAt: clock.now().toISOString(),
    });
    const finalize = () =>
      store.withTransaction((tx) =>
        tx.bulkJobs.finalizeJob(scope, jobId, 'completed', clock.now()),
      );
    const { ok, failed } = await settle([finalize(), finalize()]);
    expect(ok).toHaveLength(1);
    expect(ok[0]?.value).toMatchObject({ id: jobId, status: 'completed', succeeded: 1 });
    expect(failed[0]?.reason).toBeInstanceOf(TransactionConflictError);
    // Committed state is now final: an in-unit finalize reports null up front.
    expect(await finalize()).toBeNull();
    expect((await store.bulkJobs.getJob(scope, jobId))?.status).toBe('completed');
  });
});

describe('outbox lease claims', () => {
  it('concurrent readPending claims never return the same event', async () => {
    const appended = Array.from({ length: 40 }, (_, i) => event(String(i)));
    await store.outbox.appendMany(appended); // > one INSERT's parameter budget
    const mine = new Set(appended.map((e) => e.id));

    const [a, b] = await Promise.all([store.outbox.readPending(25), store.outbox.readPending(25)]);
    const aIds = a.map((e) => e.id);
    const bIds = b.map((e) => e.id);
    expect(aIds.filter((id) => bIds.includes(id))).toEqual([]);
    for (const batch of [a, b]) {
      const at = batch.map((e) => e.occurredAt);
      expect(at).toEqual([...at].sort());
    }
    // Every event appended here was claimed by one of the two (nothing else is pending).
    const claimed = new Set([...aIds, ...bIds]);
    expect([...mine].every((id) => claimed.has(id))).toBe(true);

    // Held leases keep a third relayer off them.
    const third = await store.outbox.readPending(100);
    expect(third.filter((e) => claimed.has(e.id))).toEqual([]);
  });

  it('a lapsed lease is re-claimed; markRelayed commits with its unit', async () => {
    const e = event('500');
    await store.outbox.append(e);
    // Claimed inside a unit, executed immediately (visible before the unit commits).
    await store
      .withTransaction(async (tx) => {
        const got = await tx.outbox.readPending(100);
        expect(got.map((x) => x.id)).toContain(e.id);
        const [row] = (
          await testDb.prepare('select claimed_by from outbox where id = ?').bind(e.id).all<{
            claimed_by: string | null;
          }>()
        ).results;
        expect(row?.claimed_by).toBeTruthy();
        throw new Error('relayer crashed before markRelayed');
      })
      .catch(() => undefined);
    expect((await store.outbox.readPending(100)).map((x) => x.id)).not.toContain(e.id);

    // Lease expires: the event is claimable again.
    await testDb.prepare('update outbox set claimed_until = 0 where id = ?').bind(e.id).run();
    await store.withTransaction(async (tx) => {
      const got = await tx.outbox.readPending(100);
      expect(got.map((x) => x.id)).toContain(e.id);
      await tx.outbox.markRelayed(got.map((x) => x.id));
    });
    const [row] = (
      await testDb.prepare('select relayed_at from outbox where id = ?').bind(e.id).all<{
        relayed_at: number | null;
      }>()
    ).results;
    expect(row?.relayed_at).not.toBeNull();
  });
});

describe('unique value claims', () => {
  const claim = (value: string) => ({
    contentTypeApiId: 'article',
    fieldApiId: 'slug',
    locale: 'en-US',
    value,
  });

  it('a racing claim of the same value loses with ConflictError (direct)', async () => {
    const value = `slug-${uid()}`;
    const { ok, failed } = await settle([
      store.entries.replaceUniqueClaims(scope, `e-a-${value}`, [claim(value)]),
      store.entries.replaceUniqueClaims(scope, `e-b-${value}`, [claim(value)]),
    ]);
    expect(ok).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(ConflictError);
    expect(String(failed[0]?.reason)).toMatch(/already uses/);
    const conflicts = await store.entries.findUniqueConflicts(scope, [claim(value)]);
    expect(conflicts).toHaveLength(1);
  });

  it('a racing claim inside units fails the losing unit with ConflictError', async () => {
    const value = `slug-${uid()}`;
    const claimIn = (entryId: string) =>
      store.withTransaction(async (tx) => {
        expect(await tx.entries.findUniqueConflicts(scope, [claim(value)], entryId)).toEqual([]);
        await tx.entries.replaceUniqueClaims(scope, entryId, [claim(value)]);
      });
    const { ok, failed } = await settle([claimIn(`u-a-${value}`), claimIn(`u-b-${value}`)]);
    expect(ok).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(ConflictError);
    expect(failed[0]?.reason).not.toBeInstanceOf(TransactionConflictError);
    expect(await store.entries.findUniqueConflicts(scope, [claim(value)])).toHaveLength(1);
  });
});

describe('D1 parameter cap', () => {
  it('splits caller-sized lists across statements', async () => {
    // 60 unique claims (4 params each) in one call, then looked up in one call.
    const owner = `cap-${uid()}`;
    const claims = Array.from({ length: 60 }, (_, i) => ({
      contentTypeApiId: 'article',
      fieldApiId: 'slug',
      locale: 'en-US',
      value: `${owner}-${i}`,
    }));
    await store.entries.replaceUniqueClaims(scope, owner, claims);
    expect(await store.entries.findUniqueConflicts(scope, claims)).toHaveLength(60);

    // 150 published snapshots written, fetched, counted and removed in single calls.
    const snaps = Array.from({ length: 150 }, (_, i) => ({
      entryId: `${owner}-p${i}`,
      contentTypeApiId: 'capdoc',
      version: 1,
      fields: { title: { 'en-US': `t${i}` } },
      publishedAt: clock.now().toISOString(),
    }));
    await store.entries.putPublishedMany(scope, snaps);
    const idList = [...snaps.map((s) => s.entryId), ...Array.from({ length: 100 }, () => uid())];
    expect(await store.entries.getPublishedMany(scope, idList)).toHaveLength(150);
    expect(await store.entries.countPublished(scope, { contentType: 'capdoc' })).toBe(150);
    await store.entries.removePublishedMany(
      scope,
      snaps.map((s) => s.entryId),
    );
    expect(await store.entries.countPublished(scope, { contentType: 'capdoc' })).toBe(0);

    // 120 draft entries: getMany + saveAggregateMany (one UPDATE per row).
    const created = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        createEntry(ctx, scope, {
          contentTypeApiId: 'article',
          fields: { title: { 'en-US': `${owner} draft ${i}` } },
        }),
      ),
    );
    const entryIds = created.map((c) => c.entry.id);
    const got = await store.entries.getMany(scope, entryIds);
    expect(got).toHaveLength(120);
    expect(got.every((g) => typeof g.fields.title?.['en-US'] === 'string')).toBe(true);
    await store.entries.saveAggregateMany(
      scope,
      got.map((g) => ({ ...g.entry, status: 'changed' as const })),
    );
    expect(
      (await store.entries.getMany(scope, entryIds)).every((g) => g.entry.status === 'changed'),
    ).toBe(true);

    // A large `in` filter is one JSON parameter, not one per value.
    const big = await store.entries.list(scope, {
      contentTypeApiId: 'article',
      limit: 1000,
      filters: [
        {
          field: 'title',
          op: 'in',
          value: Array.from({ length: 200 }, (_, i) => `${owner} draft ${i}`),
        },
      ],
    });
    expect(big).toHaveLength(120);

    // Reverse closure over 300 seeds: one JSON parameter.
    await store.references.replaceForEntries(
      scope,
      Array.from({ length: 30 }, (_, i) => ({
        fromEntryId: `${owner}-from-${i}`,
        edges: [
          {
            fromEntryId: `${owner}-from-${i}`,
            fromField: 'ref',
            toId: `${owner}-to-${i}`,
            toType: 'Entry' as const,
          },
        ],
      })),
    );
    const closure = await store.references.findReverseClosure(
      scope,
      Array.from({ length: 300 }, (_, i) => `${owner}-to-${i}`),
      { maxDepth: 3, maxEntries: 1000 },
    );
    expect(closure).toHaveLength(30);
  });
});

describe("Delivery's batched reads", () => {
  it('sends every part in one round trip, under the parameter cap, in the scope only', async () => {
    const counter = countingD1(testDb);
    const counted = createD1Store(counter.d1);
    const tag = `dr-${uid()}`;
    const snaps = Array.from({ length: 150 }, (_, i) => ({
      entryId: `${tag}-${i}`,
      contentTypeApiId: 'article',
      version: 1,
      fields: { title: { 'en-US': `t${i}` } },
      publishedAt: clock.now().toISOString(),
    }));
    await store.entries.putPublishedMany(scope, snaps);
    // Another environment, holding one of the same ids and one of its own: never an answer here.
    const elsewhere = { spaceId, environmentId: `other-${uid()}` };
    const head = snaps[0] as (typeof snaps)[number];
    await store.entries.putPublishedMany(elsewhere, [
      { ...head, fields: { title: { 'en-US': 'elsewhere' } } },
      { ...head, entryId: `${tag}-other` },
    ]);

    const entryIds = [
      ...snaps.map((s) => s.entryId),
      `${tag}-other`,
      ...Array.from({ length: 50 }, () => uid()),
    ];
    const first = head.entryId;
    let result: Awaited<ReturnType<typeof counted.delivery.read>> = {};
    const log = await counter.measure(async () => {
      result = await counted.delivery.read(scope, {
        config: true,
        contentTypes: true,
        renditions: true,
        entryId: first,
        assetId: uid(),
        entryIds,
        assetIds: [],
        assetPage: { limit: 5 },
      });
    });
    // config, content types, renditions, entry, asset, the page, and 201 ids in 3 chunks.
    expect(log).toMatchObject({ roundTrips: 1, statements: 9 });
    expect(result.config).toEqual(await store.spaces.getConfig(scope));
    expect(result.contentTypes).toEqual(await store.contentTypes.list(scope));
    expect(result.renditions).toEqual([]);
    expect(result.entry).toEqual(await store.entries.getPublished(scope, first));
    expect(result.entry?.fields.title).toEqual({ 'en-US': 't0' });
    expect(result.asset).toBeNull();
    expect(result.entries?.map((e) => e.entryId).sort()).toEqual(
      snaps.map((s) => s.entryId).sort(),
    );
    expect(result.entries?.some((e) => e.fields.title?.['en-US'] === 'elsewhere')).toBe(false);
    expect(result.assets).toEqual([]);
    expect(result.assetPage).toEqual(await store.assets.listPublished(scope, { limit: 5 }));
    await store.entries.removePublishedMany(
      scope,
      snaps.map((s) => s.entryId),
    );
  });

  it('answers only what was asked, and sends nothing for nothing', async () => {
    const counter = countingD1(testDb);
    const counted = createD1Store(counter.d1);
    let result = {};
    const none = await counter.measure(async () => {
      result = await counted.delivery.read(scope, { entryIds: [], config: false });
    });
    expect(none).toMatchObject({ roundTrips: 0, statements: 0 });
    expect(result).toEqual({ entries: [] });
    const lone = await counter.measure(async () => {
      result = await counted.delivery.read(scope, { config: true });
    });
    expect(lone).toMatchObject({ roundTrips: 1, statements: 1 });
    expect(Object.keys(result)).toEqual(['config']);
  });
});

describe('stored secrets', () => {
  it('compare-and-sets a header whose key SQLite paths cannot quote', async () => {
    const id = `sec-${uid()}`;
    await store.webhooks.create(scope, {
      id,
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret: 's',
      active: true,
      environmentId: null,
      headers: { 'X-"Odd"': 'v1', Keep: 'k' },
    });
    const ref = { column: 'webhooks.headers' as const, id, key: 'X-"Odd"' };
    expect(await store.storedSecrets.replace(ref, 'stale', 'v2')).toBe(false);
    expect(await store.storedSecrets.replace(ref, 'v1', 'v2')).toBe(true);
    expect((await store.webhooks.get(scope, id))?.headers).toEqual({ 'X-"Odd"': 'v2', Keep: 'k' });
  });
});

describe('deleting an environment', () => {
  // The use-cases check aliases before writing; these prove the batch itself re-checks, so an
  // alias set (or an environment deleted) between that check and the write cannot slip through.
  const audit = (environmentId: string) => ({
    id: uid(),
    spaceId,
    environmentId,
    at: clock.now().toISOString(),
    actor: 'test',
    action: 'environment.deleted',
    targetType: 'environment',
    targetId: environmentId,
    status: 200,
  });

  it('aborts, deleting nothing, if an alias points at it when the batch runs', async () => {
    const env = `aliased-${uid().slice(0, 8)}`;
    await createEnvironment(ctx, spaceId, env);
    await store.spaces.setAlias(spaceId, `to-${env}`, env, clock.now().toISOString());
    await expect(
      store.spaces.deleteEnvironment(spaceId, env, [], audit(env)),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect((await store.spaces.listEnvironments(spaceId)).map((x) => x.id)).toContain(env);
  });

  it('deletes nothing for an environment that is not being purged', async () => {
    const live = { spaceId, environmentId: `live-${uid().slice(0, 8)}` };
    await createEnvironment(ctx, spaceId, live.environmentId);
    await store.taxonomy.createTag(live, {
      id: `tag-${uid()}`,
      name: 'Stays',
      slug: 'stays',
      description: null,
      labels: {},
    });
    // A late step for a finished purge, or one for an id now in use again, must not touch it.
    expect(
      await store.spaces.purgeEnvironmentStep(spaceId, live.environmentId, 500, clock.now()),
    ).toBe(0);
    expect(await store.taxonomy.listTags(live)).toHaveLength(1);
  });

  it('keeps a purging environment out of the due queries', async () => {
    const env = `due-${uid().slice(0, 8)}`;
    const s = { spaceId, environmentId: env };
    await createEnvironment(ctx, spaceId, env);
    const action = {
      id: `sa-${uid()}`,
      entityType: 'Entry' as const,
      entityId: 'e1',
      action: 'publish' as const,
      scheduledFor: '2020-01-01T00:00:00.000Z',
      status: 'pending' as const,
      createdAt: '2020-01-01T00:00:00.000Z',
    };
    await store.scheduledActions.create(s, action as never);
    const due = async () =>
      (await store.scheduledActions.findDue('2021-01-01T00:00:00.000Z', 1000)).map(
        (d) => d.action.id,
      );
    expect(await due()).toContain(action.id);
    await store.spaces.deleteEnvironment(spaceId, env, [], audit(env));
    expect(await due()).not.toContain(action.id);
  });

  it('restarts only a purge that has stopped making progress', async () => {
    const env = `stalled-${uid().slice(0, 8)}`;
    await createEnvironment(ctx, spaceId, env);
    const t0 = new Date('2030-01-01T00:00:00.000Z');
    await store.spaces.deleteEnvironment(spaceId, env, [], { ...audit(env), at: t0.toISOString() });
    // A step marks progress, so a sweep looking for purges idle since before it finds none.
    await store.spaces.purgeEnvironmentStep(spaceId, env, 1, new Date(t0.getTime() + 60_000));
    const sweep = (staleBefore: number) =>
      store.spaces.claimStalledPurges(new Date(staleBefore), new Date(staleBefore), 100);
    expect((await sweep(t0.getTime() + 30_000)).map((p) => p.environmentId)).not.toContain(env);
    expect(await sweep(t0.getTime() + 120_000)).toContainEqual({ spaceId, environmentId: env });
    // Claimed: the same sweep again doesn't take it twice.
    expect((await sweep(t0.getTime() + 120_000)).map((p) => p.environmentId)).not.toContain(env);
  });

  it('refuses an alias at an environment that no longer exists', async () => {
    await expect(
      store.spaces.setAlias(
        spaceId,
        `ghost-${uid().slice(0, 8)}`,
        'gone',
        clock.now().toISOString(),
      ),
    ).rejects.toBeInstanceOf(TransactionConflictError);
  });

  it('clears every environment-scoped table but the audit log, atomically with its events', async () => {
    const doomed = { spaceId, environmentId: `doomed-${uid().slice(0, 8)}` };
    await createEnvironment(ctx, spaceId, doomed.environmentId);
    await createContentType(ctx, SYSTEM_CALLER, doomed, {
      apiId: 'article',
      name: 'Article',
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
    await publishContentType(ctx, doomed, 'article');
    const e = await createEntry(ctx, doomed, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Going away' } },
    });
    await publishEntry(ctx, doomed, e.entry.id);
    // A second entry, so the entry tables need more than one bounded step.
    await createEntry(ctx, doomed, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Also going' } },
    });
    await store.taxonomy.createTag(doomed, {
      id: `tag-${uid()}`,
      name: 'Doomed',
      slug: 'doomed',
      description: null,
      labels: {},
    });
    // A plugin's kv:storage keys belong to the environment; the same plugin's keys elsewhere stay.
    const kvOpts = { maxKeys: 10, at: clock.now() };
    await store.pluginStorage.put(doomed, 'com.example.kv', 'cursor', '1', kvOpts);
    await store.pluginStorage.put(scope, 'com.example.kv', 'cursor', '2', kvOpts);
    // Its own webhook goes with it; a space-wide one (NULL environment) stays.
    const hook = (id: string, environmentId: string | null) => ({
      id,
      url: 'https://hook.example/cw',
      topics: ['*' as const],
      secret: 's',
      active: true,
      environmentId,
    });
    const doomedHook = `wh-${uid()}`;
    const wideHook = `wh-${uid()}`;
    await store.webhooks.create(doomed, hook(doomedHook, doomed.environmentId));
    await store.webhooks.create(doomed, hook(wideHook, null));
    await store.audit.append({
      id: uid(),
      spaceId,
      environmentId: doomed.environmentId,
      at: clock.now().toISOString(),
      actor: 'test',
      action: 'entry.published',
      targetType: 'entry',
      targetId: e.entry.id,
      status: 200,
    });

    await deleteEnvironment(ctx, spaceId, doomed.environmentId, {
      confirm: doomed.environmentId,
      principal: { spaceId, kind: 'user', subject: 'usr_admin', scopes: [SCOPES.spaceAdmin] },
    });
    // Gone from the registry and marked purging, at once; the id can't be reused until purged.
    expect(await store.spaces.resolveName(spaceId, doomed.environmentId)).toEqual({
      targetEnvironmentId: null,
      purging: true,
    });
    await expect(createEnvironment(ctx, spaceId, doomed.environmentId)).rejects.toBeInstanceOf(
      ConflictError,
    );

    // Bounded steps: at most `rowsPerTable` rows from each table per step, counted from D1.
    const perStep: number[] = [];
    for (;;) {
      const n = await store.spaces.purgeEnvironmentStep(
        spaceId,
        doomed.environmentId,
        1,
        clock.now(),
      );
      if (n === 0) break;
      perStep.push(n);
    }
    expect(perStep.length).toBeGreaterThan(1);
    expect(Math.max(...perStep)).toBeLessThanOrEqual(33);
    await store.spaces.finishEnvironmentPurge(spaceId, doomed.environmentId);
    expect((await store.spaces.resolveName(spaceId, doomed.environmentId)).purging).toBe(false);

    // Every table with an environment_id column, found from the schema itself, so a table added
    // later without joining the delete list fails here.
    const tables = (
      await testDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%`environment_id`%'",
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(tables.length).toBeGreaterThan(30);
    const left: Record<string, number> = {};
    for (const table of tables) {
      const row = await testDb
        .prepare(`SELECT count(*) AS n FROM "${table}" WHERE space_id = ? AND environment_id = ?`)
        .bind(spaceId, doomed.environmentId)
        .first<{ n: number }>();
      if ((row?.n ?? 0) > 0) left[table] = row?.n ?? 0;
    }
    // Its earlier history stays, with the index of which entries it was about (an entry's
    // activity), and the deletion itself is recorded, by whom.
    expect(left).toEqual({ audit_log: 2, audit_log_entries: 1 });
    const recorded = await testDb
      .prepare(
        "SELECT actor, target_id FROM audit_log WHERE environment_id = ? AND action = 'environment.deleted'",
      )
      .bind(doomed.environmentId)
      .first<{ actor: string; target_id: string }>();
    expect(recorded).toEqual({ actor: 'usr_admin', target_id: doomed.environmentId });
    expect((await store.spaces.listEnvironments(spaceId)).map((x) => x.id)).not.toContain(
      doomed.environmentId,
    );
    // The cleanup events went into the outbox in the same write.
    const announced = await testDb
      .prepare("SELECT payload FROM outbox WHERE type = 'environment.deleted'")
      .all<{ payload: string }>();
    expect(
      announced.results.some(
        (r) => JSON.parse(r.payload).scope.environmentId === doomed.environmentId,
      ),
    ).toBe(true);
    // The rest of the space is untouched.
    expect(await store.contentTypes.list(scope)).not.toEqual([]);
    expect((await store.webhooks.list(scope)).map((w) => w.id)).toContain(wideHook);
    expect((await store.webhooks.list(scope)).map((w) => w.id)).not.toContain(doomedHook);
    expect(await store.pluginStorage.get(scope, 'com.example.kv', 'cursor')).toBe('2');
  });
});

describe('webhook environments', () => {
  const space = `wh-${uid()}`;
  const main = { spaceId: space, environmentId: 'main' };
  const staging = { spaceId: space, environmentId: 'staging' };
  const hook = (id: string, environmentId: string | null, topics: string[] = ['*']) => ({
    id,
    url: 'https://hook.example/cw',
    topics: topics as ['*'],
    secret: 's',
    active: true,
    environmentId,
  });
  const ids = (ws: { id: string }[]) => ws.map((w) => w.id).sort();

  it('matches an event to the hooks of its environment and the space-wide ones', async () => {
    const [m, st, wide, other] = [uid(), uid(), uid(), uid()];
    await store.webhooks.create(main, hook(m, 'main'));
    await store.webhooks.create(staging, hook(st, 'staging'));
    await store.webhooks.create(main, hook(wide, null, ['entry.published']));
    // Another space's space-wide hook never matches.
    await store.webhooks.create(
      { spaceId: `other-${uid()}`, environmentId: 'staging' },
      hook(other, null),
    );

    expect(ids(await store.webhooks.listByTopic(staging, 'entry.published'))).toEqual(
      [st, wide].sort(),
    );
    expect(ids(await store.webhooks.listByTopic(staging, 'entry.unpublished'))).toEqual([st]);
    expect(ids(await store.webhooks.listByTopic(main, 'entry.published'))).toEqual(
      [m, wide].sort(),
    );
    expect(ids(await store.webhooks.list(staging))).toEqual([st, wide].sort());
    expect(await store.webhooks.get(staging, st)).toMatchObject({ environmentId: 'staging' });
    expect(await store.webhooks.get(staging, wide)).toMatchObject({ environmentId: null });
  });

  it("neither reads, changes nor deletes another environment's hook", async () => {
    const id = uid();
    await store.webhooks.create(main, hook(id, 'main'));
    expect(await store.webhooks.get(staging, id)).toBeNull();
    await store.webhooks.update(staging, { ...hook(id, null), active: false });
    await store.webhooks.delete(staging, id);
    expect(await store.webhooks.get(main, id)).toMatchObject({
      active: true,
      environmentId: 'main',
    });
    // Rescoped from its own environment, it moves.
    await store.webhooks.update(main, hook(id, 'staging'));
    expect(await store.webhooks.get(main, id)).toBeNull();
    expect(await store.webhooks.get(staging, id)).toMatchObject({ environmentId: 'staging' });
  });

  it('treats a hook written before the column existed (NULL) as space-wide', async () => {
    const id = uid();
    await testDb
      .prepare(
        "INSERT INTO webhooks (id, space_id, url, topics, secret) VALUES (?, ?, 'https://hook.example/cw', '[\"*\"]', 's')",
      )
      .bind(id, space)
      .run();
    expect(ids(await store.webhooks.listByTopic(staging, 'entry.published'))).toContain(id);
    expect(ids(await store.webhooks.listByTopic(main, 'entry.published'))).toContain(id);
  });
});
