import {
  ConflictError,
  type EnvironmentPurgeDueEvent,
  ForbiddenError,
  NotFoundError,
  type Principal,
  ValidationError,
} from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  InMemorySearchIndex,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  compareEnvironments,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  createWebhook,
  deleteEnvironment,
  dispatchEvent,
  listWebhooks,
  mergeEnvironments,
  publishContentType,
  publishEntry,
  resolveEnvironment,
  resolveWritableEnvironment,
  resumeStalledEnvironmentPurges,
  runDueScheduledActions,
  runEnvironmentPurge,
  SYSTEM_CALLER,
  scheduleAction,
  setEnvironmentAlias,
  visibleSearchHits,
} from '../src/index';

const main = { spaceId: 's1', environmentId: 'main' };
const admin = { spaceId: '*', kind: 'admin', scopes: [] } as unknown as Principal;
const staging = { spaceId: 's1', environmentId: 'staging' };
let ctx: AppContext;
let store: InMemoryContentStore;

async function seed(scope: typeof main) {
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
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(ctx, scope, 'article');
  const a = await createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': 'Published' } },
  });
  await publishEntry(ctx, scope, a.entry.id);
  await createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': 'Draft' } },
  });
  return a.entry.id;
}

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  await createSpace(ctx, { spaceId: 's1', name: 'S1', defaultLocale: 'en-US' });
  await createEnvironment(ctx, 's1', 'staging');
});

describe('deleting an environment', () => {
  it('removes everything in it, leaves other environments alone, and announces the cleanup', async () => {
    await seed(main);
    const published = await seed(staging);
    const hook = { topics: ['*' as const], secret: 's' };
    await createWebhook(ctx, main, { ...hook, url: 'https://hooks.example.com/main' });
    await createWebhook(ctx, staging, { ...hook, url: 'https://hooks.example.com/staging' });
    await createWebhook(ctx, staging, {
      ...hook,
      url: 'https://hooks.example.com/everywhere',
      allEnvironments: true,
    });

    const result = await deleteEnvironment(ctx, 's1', 'staging', {
      confirm: 'staging',
      principal: admin,
    });
    expect(result).toEqual({ environmentId: 'staging', publishedEntries: 1 });
    // Gone at once: it no longer resolves, for reads or writes, and its id can't be reused yet.
    expect((await store.spaces.listEnvironments('s1')).map((e) => e.id)).toEqual(['main']);
    await expect(resolveEnvironment(ctx, 's1', 'staging')).rejects.toBeInstanceOf(NotFoundError);
    await expect(createEnvironment(ctx, 's1', 'staging')).rejects.toBeInstanceOf(ConflictError);

    // The engine removes its rows in bounded steps, chaining events until none are left.
    const purge = (await store.outbox.readPending(100)).filter(
      (e) => e.type === 'environment.purge_due',
    );
    expect(purge).toMatchObject([{ scope: staging }]);
    expect(await runEnvironmentPurge(ctx, {}, purge[0] as EnvironmentPurgeDueEvent)).toBe(
      'finished',
    );

    expect(await store.contentTypes.list(staging)).toEqual([]);
    expect(await store.entries.list(staging, {})).toEqual([]);
    // Its own webhooks went with it; the space-wide one and main's stay.
    expect((await listWebhooks(ctx, main)).map((w) => w.url).sort()).toEqual([
      'https://hooks.example.com/everywhere',
      'https://hooks.example.com/main',
    ]);
    expect(await store.entries.getPublished(staging, published)).toBeNull();
    expect((await store.spaces.listEnvironments('s1')).map((e) => e.id)).toEqual(['main']);
    // main is untouched.
    expect(await store.contentTypes.list(main)).toHaveLength(1);
    expect(await store.entries.list(main, {})).toHaveLength(2);
    // Once purged, the id is free again.
    await createEnvironment(ctx, 's1', 'staging');
    // The engine is told which published entries to drop from search and vectors.
    const pending = await store.outbox.readPending(100);
    const deleted = pending.filter((e) => e.type === 'environment.deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ scope: staging, entryIds: [published] });
    // Recorded with the deletion, naming who did it.
    const audit = await store.audit.list('s1', { environmentId: 'staging' });
    expect(audit.find((a) => a.action === 'environment.deleted')).toMatchObject({
      actor: 'admin-token',
      targetId: 'staging',
    });
  });

  it('announces even an empty environment, so its delivery cache is purged', async () => {
    await deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin });
    const pending = await store.outbox.readPending(100);
    expect(pending.filter((e) => e.type === 'environment.deleted')).toMatchObject([
      { scope: staging, entryIds: [] },
    ]);
  });

  it('needs the environment id repeated as confirmation', async () => {
    await expect(
      deleteEnvironment(ctx, 's1', 'staging', { principal: admin }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      deleteEnvironment(ctx, 's1', 'staging', { confirm: 'main', principal: admin }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await store.spaces.listEnvironments('s1')).map((e) => e.id)).toContain('staging');
  });

  it('refuses an API key, even one holding space:admin', async () => {
    const key = { spaceId: 's1', kind: 'cma', scopes: ['space:admin'] } as unknown as Principal;
    await expect(
      deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: key }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await store.spaces.listEnvironments('s1')).map((e) => e.id)).toContain('staging');
  });

  it('refuses main, an unknown environment, and one an alias points at', async () => {
    await expect(
      deleteEnvironment(ctx, 's1', 'main', { confirm: 'main', principal: admin }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      deleteEnvironment(ctx, 's1', 'nope', { confirm: 'nope', principal: admin }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await setEnvironmentAlias(ctx, 's1', 'live', 'staging');
    await expect(
      deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('cleaning up after a deleted environment', () => {
  it('drops each published entry from the search index and the vectors', async () => {
    const searchIndex = new InMemorySearchIndex();
    const vectors = new InMemoryVectorStore();
    const embeddings = new LocalEmbeddingsProvider(32);
    const deps = {
      sender: new RecordingWebhookSender(),
      searchIndex,
      rag: { embeddings, vectors },
    };
    await searchIndex.index(staging, {
      entryId: 'gone',
      contentTypeApiId: 'article',
      textByLocale: { 'en-US': 'gone forever' },
      entryVersion: 1,
    });
    await vectors.upsert([
      {
        scope: staging,
        entryId: 'gone',
        locale: 'en-US',
        chunkIndex: 0,
        chunkText: 'gone forever',
        embedding: (await embeddings.embed(['gone forever']))[0] as number[],
        entryVersion: 1,
      },
    ]);
    await dispatchEvent(ctx, deps, {
      id: 'evt-del',
      type: 'environment.deleted',
      scope: staging,
      occurredAt: '2026-01-01T00:00:00.000Z',
      entryIds: ['gone'],
    });
    expect(await searchIndex.search(staging, 'gone', { topK: 5 })).toEqual([]);
    expect(
      await vectors.query(staging, (await embeddings.embed(['gone forever']))[0] as number[], {
        topK: 5,
      }),
    ).toEqual([]);
  });
});

describe('search results after content goes away', () => {
  it('drops hits on entries no longer published, for every caller', async () => {
    const published = await seed(staging);
    const hits = [
      { entryId: published, score: 1, snippet: 'live' },
      { entryId: 'deleted-or-unpublished', score: 0.9, snippet: 'stale snippet' },
    ];
    // An index or vector store that still holds a document (a missed unpublish, a deleted
    // environment) must not serve its snippet, restricted or not.
    expect(await visibleSearchHits(ctx, staging, admin, hits)).toEqual([hits[0]]);
  });
});

describe("a deleted environment's files", () => {
  it("go when its purge finishes, except any another environment's asset records still point at", async () => {
    const blob = new FakeBlobStore();
    await blob.put('s1/staging/only-here/x.png', 'x', 'image/png');
    await blob.put('s1/staging/cloned/y.png', 'y', 'image/png');
    await blob.put('s1/main/m1/z.png', 'z', 'image/png');
    // Staged work of an import that was running in it.
    await blob.put('imports/s1/staging/job1/c00000.json', '{}', 'application/json');
    // And its archived version bodies.
    await blob.put('versions/s1/staging/e1/1.json', '{}', 'application/json');
    // main holds an asset record with the staging file's id, as a clone of staging would.
    await store.assets.create(main, {
      id: 'cloned',
      status: 'draft',
      file: { url: '/media/s1/staging/cloned/y.png', fileName: 'y.png', contentType: 'image/png' },
      title: {},
      description: {},
      metadata: { altText: {}, tags: [] },
    } as never);
    await deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin });
    await dispatchEvent(
      ctx,
      { sender: new RecordingWebhookSender(), blob },
      {
        id: 'evt-files',
        type: 'environment.purge_due',
        scope: staging,
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    );
    expect(blob.keys().sort()).toEqual(['s1/main/m1/z.png', 's1/staging/cloned/y.png']);
  });
});

describe("a deleted environment's files, next to other data in the bucket", () => {
  const purgeDue = (scope: { spaceId: string; environmentId: string }) =>
    ({
      id: `evt-${scope.spaceId}-${scope.environmentId}`,
      type: 'environment.purge_due',
      scope,
      occurredAt: '2026-01-01T00:00:00.000Z',
    }) as const;

  it('stay while a clone in another space still names them', async () => {
    const blob = new FakeBlobStore();
    await blob.put('s1/staging/cloned/y.png', 'y', 'image/png');
    await blob.put('s1/staging/only-here/x.png', 'x', 'image/png');
    await createSpace(ctx, { spaceId: 's2', name: 'S2', defaultLocale: 'en-US' });
    await store.assets.create({ spaceId: 's2', environmentId: 'main' }, {
      id: 'cloned',
      status: 'draft',
      r2Key: 's1/staging/cloned/y.png',
      file: { url: '/media/s1/staging/cloned/y.png', fileName: 'y.png', contentType: 'image/png' },
      title: {},
      description: {},
      metadata: { altText: {}, tags: [] },
    } as never);
    await deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin });
    await dispatchEvent(ctx, { sender: new RecordingWebhookSender(), blob }, purgeDue(staging));
    expect(blob.keys()).toEqual(['s1/staging/cloned/y.png']);
  });

  it("never reach another space's version bodies, staging or plugin bundles", async () => {
    const blob = new FakeBlobStore();
    await createSpace(ctx, { spaceId: 's2', name: 'S2', defaultLocale: 'en-US' });
    await createEnvironment(ctx, 's2', 'staging');
    await blob.put('s1/staging/a1/x.png', 'x', 'image/png');
    await blob.put('versions/s1/staging/e1/1.json', '{}', 'application/json');
    const kept = [
      's1/main/m1/z.png',
      's2/staging/a2/y.png',
      'versions/s1/main/e2/1.json',
      'versions/s2/staging/e3/1.json',
      'imports/s2/staging/job1/c00000.json',
      'plugins/s1/p1/abc.js',
      'dlq/s1/staging/m1.json',
    ];
    for (const key of kept) await blob.put(key, '{}', 'application/json');
    await deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin });
    await dispatchEvent(ctx, { sender: new RecordingWebhookSender(), blob }, purgeDue(staging));
    expect(blob.keys().sort()).toEqual([...kept].sort());
  });

  it('leave its asset files behind for a space created before reserved ids, not reach others', async () => {
    // As a row written before space creation refused the bucket's shared prefixes could be.
    await store.spaces.create({
      spaceId: 'versions',
      name: 'Old',
      defaultLocale: 'en-US',
      locales: ['en-US'],
    });
    await store.spaces.createEnvironment('versions', 'main', 'main');
    await store.spaces.createEnvironment('versions', 's1', 's1');
    const blob = new FakeBlobStore();
    // s1's archived version bodies sit exactly where space "versions", environment "s1" keeps
    // its asset files.
    await blob.put('versions/s1/main/e1/1.json', '{}', 'application/json');
    await blob.put('versions/s1/staging/e2/1.json', '{}', 'application/json');
    await deleteEnvironment(ctx, 'versions', 's1', { confirm: 's1', principal: admin });
    await dispatchEvent(
      ctx,
      { sender: new RecordingWebhookSender(), blob },
      purgeDue({ spaceId: 'versions', environmentId: 's1' }),
    );
    expect(blob.keys().sort()).toEqual([
      'versions/s1/main/e1/1.json',
      'versions/s1/staging/e2/1.json',
    ]);
  });
});

describe('the environment a write names', () => {
  it('is an existing one, or an alias of one; anything else is not found', async () => {
    await setEnvironmentAlias(ctx, 's1', 'live', 'staging');
    expect(await resolveWritableEnvironment(ctx, 's1', 'staging')).toBe('staging');
    expect(await resolveWritableEnvironment(ctx, 's1', 'live')).toBe('staging');
    await expect(resolveWritableEnvironment(ctx, 's1', 'stagign')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('an alias racing a deletion', () => {
  it('reports a conflict, and deletes nothing, when an alias lands after the check', async () => {
    await setEnvironmentAlias(ctx, 's1', 'live', 'staging');
    // The check reads no aliases, as if the alias were set just after it.
    store.spaces.listAliases = async () => [];
    await expect(
      deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await store.spaces.listEnvironments('s1')).map((e) => e.id)).toContain('staging');
  });

  it('reports the target not found when it is deleted after the check', async () => {
    // The check sees an environment the write will not find.
    const real = store.spaces.listEnvironments;
    store.spaces.listEnvironments = async (spaceId) => [
      ...(await real(spaceId)),
      { id: 'gone', name: 'gone' },
    ];
    await expect(setEnvironmentAlias(ctx, 's1', 'live', 'gone')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await store.spaces.getAlias('s1', 'live')).toBeNull();
  });
});

describe('purging a deleted environment', () => {
  it('goes in bounded steps, handing on to another event when one runs out', async () => {
    await seed(staging);
    await deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin });
    const first = (await store.outbox.readPending(100)).find(
      (e) => e.type === 'environment.purge_due',
    ) as EnvironmentPurgeDueEvent;
    // One row per table per step, and one step per event: the seed needs several events.
    const step = store.spaces.purgeEnvironmentStep;
    store.spaces.purgeEnvironmentStep = (s, e, _rows, at) => step(s, e, 1, at);
    let event = first;
    let events = 0;
    for (;;) {
      events += 1;
      if ((await runEnvironmentPurgeSteps(event, 1)) === 'finished') break;
      const next = (await store.outbox.readPending(500)).filter(
        (e) => e.type === 'environment.purge_due' && e.id !== event.id,
      );
      event = next[next.length - 1] as EnvironmentPurgeDueEvent;
    }
    expect(events).toBeGreaterThan(2);
    expect(await store.entries.list(staging, {})).toEqual([]);
    await createEnvironment(ctx, 's1', 'staging');
  });

  it('marks progress and hands on in one unit: a failed hand-off leaves no mark', async () => {
    await deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin });
    const event = (await store.outbox.readPending(100)).find(
      (e) => e.type === 'environment.purge_due',
    ) as EnvironmentPurgeDueEvent;
    const later = { ...ctx, clock: new FixedClock(new Date('2026-01-01T00:10:00.000Z')) };
    const append = store.outbox.append;
    store.outbox.append = async () => {
      throw new Error('outbox write failed');
    };
    const search = { index: new InMemorySearchIndex() };
    await expect(runEnvironmentPurge(later, { assetSearch: search }, event)).rejects.toThrow(
      'outbox write failed',
    );
    store.outbox.append = append;
    // The mark rolled back with the hand-off: the purge still reads as stalled, so the sweep
    // restarts it rather than waiting on an event that was never written.
    expect(await resumeStalledEnvironmentPurges(later)).toBe(1);
  });

  it('restarts one whose event was lost, once it stalls', async () => {
    await deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin });
    const before = (await store.outbox.readPending(100)).length;
    // Not yet stale: nothing to restart.
    expect(await resumeStalledEnvironmentPurges(ctx)).toBe(0);
    const later = { ...ctx, clock: new FixedClock(new Date('2026-01-01T00:10:00.000Z')) };
    expect(await resumeStalledEnvironmentPurges(later)).toBe(1);
    // Claimed: a second sweep straight after doesn't restart it again.
    expect(await resumeStalledEnvironmentPurges(later)).toBe(0);
    const added = (await store.outbox.readPending(100)).slice(before);
    expect(added).toMatchObject([{ type: 'environment.purge_due', scope: staging }]);
  });
});

/** Runs a purge event with a given number of steps per event (the constant is the real cap). */
async function runEnvironmentPurgeSteps(event: EnvironmentPurgeDueEvent, steps: number) {
  const step = store.spaces.purgeEnvironmentStep;
  let left = steps;
  store.spaces.purgeEnvironmentStep = async (...args) => {
    if (left-- <= 0) return 1; // pretend more remain, so the event hands on
    return step(...args);
  };
  try {
    return await runEnvironmentPurge(ctx, {}, event);
  } finally {
    store.spaces.purgeEnvironmentStep = step;
  }
}

describe('after a purge has finished', () => {
  it('a late or duplicate purge event leaves a recreated environment alone', async () => {
    await seed(staging);
    await deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin });
    const stale = (await store.outbox.readPending(100)).find(
      (e) => e.type === 'environment.purge_due',
    ) as EnvironmentPurgeDueEvent;
    const blob = new FakeBlobStore();
    expect(await runEnvironmentPurge(ctx, { blob }, stale)).toBe('finished');

    // The id is used again, with content and a file of its own.
    await createEnvironment(ctx, 's1', 'staging');
    await seed(staging);
    await blob.put('s1/staging/a1/new.png', 'n', 'image/png');

    // The same event again (a redelivery, or a chain the sweep restarted): nothing happens.
    expect(await runEnvironmentPurge(ctx, { blob }, stale)).toBe('finished');
    expect(await store.entries.list(staging, {})).toHaveLength(2);
    expect(blob.keys()).toEqual(['s1/staging/a1/new.png']);
    // And the store's step refuses on its own, without the use-case's check.
    expect(await store.spaces.purgeEnvironmentStep('s1', 'staging', 500, new Date())).toBe(0);
  });
});

describe('a deleted environment while it is purged', () => {
  it('runs none of its scheduled actions', async () => {
    const entryId = await seed(staging);
    await scheduleAction(ctx, staging, {
      entityType: 'Entry',
      entityId: entryId,
      action: 'unpublish',
      scheduledFor: '2025-12-31T00:00:00.000Z',
    });
    await deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin });
    expect(await runDueScheduledActions(ctx)).toMatchObject({ executed: 0, failed: 0 });
    // Still published in the leftovers: nothing acted on them.
    expect(await store.entries.getPublished(staging, entryId)).not.toBeNull();
  });

  it('is not found to compare or merge', async () => {
    await deleteEnvironment(ctx, 's1', 'staging', { confirm: 'staging', principal: admin });
    await expect(compareEnvironments(ctx, 's1', 'staging', 'main')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      mergeEnvironments(ctx, 's1', 'staging', 'main', { contentTypes: ['article'] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      mergeEnvironments(ctx, 's1', 'main', 'staging', { contentTypes: ['article'] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
