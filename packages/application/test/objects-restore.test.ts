import {
  type ActiveObjects,
  BackupRefusal,
  type BackupStore,
  type ObjectState,
} from '@commerceworker/ports/commerce';
import { describe, expect, it, vi } from 'vitest';
import {
  checkProbe,
  type DrillProbe,
  findBookmarks,
  MAX_RESTORE_NAMES,
  parseObjectsRestore,
  type RestoreReport,
  reindexObject,
  restoreObject,
  restoreReportKey,
  SNAPSHOT_PAGE,
  snapshotChunk,
  snapshotChunkKey,
  undoKey,
  writeRestoreReport,
} from '../src/commerce/objects-restore';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const DAY = 86_400_000;

/** A bucket in a map; a put over a key that exists throws, as a locked prefix does. */
function memoryStore() {
  const objects = new Map<string, { body: Uint8Array; customMetadata?: Record<string, string> }>();
  const store: BackupStore = {
    async head(key) {
      return objects.get(key) ?? null;
    },
    async get(key) {
      const o = objects.get(key);
      return o && { arrayBuffer: async () => o.body.slice().buffer as ArrayBuffer };
    },
    async put(key, value, options) {
      if (objects.has(key)) throw new Error('locked');
      const body =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : new Uint8Array(value as ArrayBuffer);
      objects.set(key, { body, customMetadata: options?.customMetadata });
      return objects.get(key)!;
    },
    async list() {
      return { objects: [], delimitedPrefixes: [], truncated: false };
    },
  };
  return { store, objects };
}

/**
 * Durable Objects as point-in-time recovery has them, without the recovery: a bookmark for a time
 * is `bm@<time>`, and a rewind keeps its undo where the object would and then throws, as the
 * object aborting fails the call that set it.
 */
function fakeObjects(store: BackupStore, over: Partial<ObjectState> = {}) {
  const calls: string[] = [];
  const state: ObjectState = {
    async pitrBookmark(cls, name, at) {
      calls.push(`bookmark ${cls} ${name}`);
      return `bm@${at}`;
    },
    async restoreTo(cls, name, bookmark, key) {
      calls.push(`restore ${cls} ${name} ${bookmark}`);
      await store.put(key, '{}', { customMetadata: { undo: `undo-of-${name}` } });
      throw new Error('the object aborted');
    },
    async exportState(cls, name) {
      return { tables: { t: [{ cls, name }] } };
    },
    async reindex(cls, name) {
      calls.push(`reindex ${cls} ${name}`);
    },
    ...over,
  };
  return { state, calls };
}

describe('what a restore is asked for', () => {
  const good = { class: 'OrderAgent', names: ['ord_1'], at: '2026-11-12T09:30:00Z' };

  it('takes a time, or the bookmarks of an earlier restore', () => {
    expect(parseObjectsRestore(good, NOW)).toEqual({
      class: 'OrderAgent',
      names: ['ord_1'],
      mode: 'at',
      at: Date.parse('2026-11-12T09:30:00Z'),
    });
    expect(
      parseObjectsRestore(
        { class: 'CartAgent', names: ['c1'], bookmarks: { c1: 'bm', other: 'x' } },
        NOW,
      ),
    ).toEqual({ class: 'CartAgent', names: ['c1'], mode: 'bookmarks', bookmarks: { c1: 'bm' } });
  });

  it('refuses an unknown class, even one the platform has', () => {
    for (const cls of ['AssistantAgent', 'HealthProbe', 'orderagent', undefined])
      expect(() => parseObjectsRestore({ ...good, class: cls }, NOW)).toThrow(BackupRefusal);
    expect(() => parseObjectsRestore({ ...good, class: 'Nope' }, NOW)).toThrow(/"class" is one of/);
  });

  it('refuses a time older than 30 days, one in the future and one that is not RFC 3339', () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    expect(() => parseObjectsRestore({ ...good, at: at(31 * DAY) }, NOW)).toThrow(/30 days/);
    expect(parseObjectsRestore({ ...good, at: at(29 * DAY) }, NOW).mode).toBe('at');
    expect(() => parseObjectsRestore({ ...good, at: at(-DAY) }, NOW)).toThrow(/in the past/);
    for (const bad of ['yesterday', '2026-11-12', 1794000000000, ''])
      expect(() => parseObjectsRestore({ ...good, at: bad }, NOW)).toThrow(/RFC 3339/);
  });

  it('refuses too many names, none, repeats and odd ones', () => {
    const many = Array.from({ length: MAX_RESTORE_NAMES + 1 }, (_, i) => `o${i}`);
    expect(() => parseObjectsRestore({ ...good, names: many }, NOW)).toThrow(/too many/);
    expect(
      parseObjectsRestore({ ...good, names: many.slice(0, MAX_RESTORE_NAMES) }, NOW).names,
    ).toHaveLength(MAX_RESTORE_NAMES);
    expect(() => parseObjectsRestore({ ...good, names: [] }, NOW)).toThrow(/list of object names/);
    expect(() => parseObjectsRestore({ ...good, names: ['a', 'a'] }, NOW)).toThrow(/repeats/);
    expect(() => parseObjectsRestore({ ...good, names: [''] }, NOW)).toThrow(/non-empty/);
    expect(() => parseObjectsRestore({ ...good, names: [7] }, NOW)).toThrow(/non-empty/);
  });

  it('needs exactly one of at and bookmarks, and a bookmark for every name', () => {
    expect(() => parseObjectsRestore({ class: 'OrderAgent', names: ['a'] }, NOW)).toThrow(
      /exactly one/,
    );
    expect(() => parseObjectsRestore({ ...good, bookmarks: { ord_1: 'bm' } }, NOW)).toThrow(
      /exactly one/,
    );
    expect(() =>
      parseObjectsRestore({ class: 'OrderAgent', names: ['a', 'b'], bookmarks: { a: 'x' } }, NOW),
    ).toThrow(/b has no bookmark/);
  });
});

describe('finding bookmarks', () => {
  it('finds one per object for the time asked', async () => {
    const { state, calls } = fakeObjects(memoryStore().store);
    const plan = parseObjectsRestore(
      { class: 'CartAgent', names: ['a', 'b'], at: '2026-11-12T09:30:00Z' },
      NOW,
    );
    const at = Date.parse('2026-11-12T09:30:00Z');
    expect(await findBookmarks(state, plan)).toEqual({ a: `bm@${at}`, b: `bm@${at}` });
    expect(calls).toEqual(['bookmark CartAgent a', 'bookmark CartAgent b']);
  });

  it('refuses the whole restore when any object has none, before one is touched', async () => {
    const { state, calls } = fakeObjects(memoryStore().store, {
      async pitrBookmark(_c, name) {
        if (name === 'b') throw new Error('out of range');
        return 'bm';
      },
    });
    const plan = parseObjectsRestore(
      { class: 'OrderAgent', names: ['a', 'b'], at: '2026-11-12T09:30:00Z' },
      NOW,
    );
    await expect(findBookmarks(state, plan)).rejects.toThrow(
      /nothing was changed: b: out of range/,
    );
    expect(calls.filter((c) => c.startsWith('restore'))).toEqual([]);
  });
});

describe('rewinding one object', () => {
  const at = { class: 'OrderAgent', name: 'ord_1', bookmark: 'bm1', instance: 'run-1' };

  it('takes the undo the object kept, though the call that set the rewind fails', async () => {
    const { store, objects } = memoryStore();
    const { state, calls } = fakeObjects(store);
    expect(await restoreObject(state, store, at)).toBe('undo-of-ord_1');
    expect(calls).toEqual(['restore OrderAgent ord_1 bm1']);
    expect(objects.has('objects/restores/run-1/OrderAgent/ord_1.undo.json')).toBe(true);
  });

  it('does not rewind twice: a retried step keeps the first undo, not the restored state', async () => {
    const { store } = memoryStore();
    const { state, calls } = fakeObjects(store);
    await restoreObject(state, store, at);
    expect(await restoreObject(state, store, at)).toBe('undo-of-ord_1');
    expect(calls).toHaveLength(1);
  });

  it('fails when the rewind was never set, so the step retries', async () => {
    const { store } = memoryStore();
    const { state } = fakeObjects(store, {
      restoreTo: vi.fn().mockRejectedValue(new Error('no such bookmark')),
    });
    await expect(restoreObject(state, store, at)).rejects.toThrow('no such bookmark');
  });

  it('fails when the rewind is set but the object never restarted into it', async () => {
    const { store } = memoryStore();
    const { state } = fakeObjects(store, {
      async restoreTo(_c, _n, _b, key) {
        await store.put(key, '{}', { customMetadata: { undo: 'u' } });
      },
    });
    await expect(restoreObject(state, store, at)).rejects.toThrow(/didn't restart/);
  });

  it('keeps an object whose name has odd characters in its own key', () => {
    expect(undoKey('run', 'CartAgent', 'a/b c')).toBe(
      'objects/restores/run/CartAgent/a%2Fb%20c.undo.json',
    );
  });
});

describe('after a restore', () => {
  it('brings the order’s and the cart’s D1 rows back in step, and no other class has one', async () => {
    const { state, calls } = fakeObjects(memoryStore().store);
    expect(await reindexObject(state, 'OrderAgent', 'ord_1')).toBe(true);
    expect(await reindexObject(state, 'CartAgent', 'c1')).toBe(true);
    expect(await reindexObject(state, 'A2AAgent', 'tok')).toBe(false);
    expect(await reindexObject(state, 'PluginStorage', 'p')).toBe(false);
    expect(calls).toEqual(['reindex OrderAgent ord_1', 'reindex CartAgent c1']);
  });

  it('lets a failed re-index surface, so the step retries', async () => {
    const { state } = fakeObjects(memoryStore().store, {
      reindex: vi.fn().mockRejectedValue(new Error('D1 down')),
    });
    await expect(reindexObject(state, 'OrderAgent', 'ord_1')).rejects.toThrow('D1 down');
  });
});

describe('the restore report', () => {
  const report: RestoreReport = {
    instance: 'run-1',
    startedAt: '2026-11-12T12:00:00.123Z',
    finishedAt: '2026-11-12T12:00:09.000Z',
    class: 'OrderAgent',
    mode: 'at',
    at: '2026-11-12T09:30:00.000Z',
    outcome: 'restored',
    objects: [{ name: 'ord_1', bookmark: 'bm', undo: 'u1', reindexed: true }],
    undo: { ord_1: 'u1' },
  };

  it('is written once under objects/restores/<time>.json with each undo bookmark', async () => {
    const { store, objects } = memoryStore();
    await writeRestoreReport(store, report);
    expect(restoreReportKey(report.startedAt)).toBe(
      'objects/restores/2026-11-12T12-00-00-123Z.json',
    );
    const kept = JSON.parse(
      new TextDecoder().decode(objects.get('objects/restores/2026-11-12T12-00-00-123Z.json')!.body),
    );
    expect(kept.undo).toEqual({ ord_1: 'u1' });
    // A retried step writes it again: the bucket lock would refuse, so it looks first.
    await expect(writeRestoreReport(store, report)).resolves.toBeUndefined();
  });
});

describe('the nightly copy', () => {
  /** An index of `n` objects, `o001`…, paged by name. */
  const active = (n: number): ActiveObjects => ({
    async page(_cls, after, limit) {
      const all = Array.from({ length: n }, (_, i) => `o${String(i + 1).padStart(3, '0')}`);
      const names = all.filter((x) => x > after).slice(0, limit + 1);
      const page = names.slice(0, limit);
      return { names: page, next: page.at(-1) ?? after, more: names.length > limit };
    },
  });
  const at = { date: '2026-11-12', class: 'OrderAgent' as const, n: 0, after: '' };

  it('walks the index a page at a time, resuming from each chunk’s cursor', async () => {
    const { store, objects } = memoryStore();
    const { state } = fakeObjects(store);
    const seen: string[] = [];
    let step = { chunk: null as unknown, next: '', more: true };
    for (let n = 0; step.more; n++) {
      step = (await snapshotChunk(active(60), state, store, {
        ...at,
        n,
        after: step.next,
      })) as never;
      seen.push((step.chunk as { key: string }).key);
    }
    expect(seen).toEqual([0, 1, 2].map((n) => snapshotChunkKey('2026-11-12', 'OrderAgent', n)));
    expect(objects.get(seen[0]!)?.customMetadata).toMatchObject({
      objects: String(SNAPSHOT_PAGE),
      errors: '0',
      next: 'o025',
      more: 'true',
    });
    expect(objects.get(seen[2]!)?.customMetadata).toMatchObject({ objects: '10', more: 'false' });
  });

  it('does not read a stored chunk again, and a retry carries on from where it ends', async () => {
    const { store } = memoryStore();
    const exportState = vi.fn(async () => ({ tables: {} }));
    const { state } = fakeObjects(store, { exportState });
    const first = await snapshotChunk(active(60), state, store, at);
    const calls = exportState.mock.calls.length;
    const again = await snapshotChunk(active(60), state, store, at);
    expect(exportState.mock.calls.length).toBe(calls);
    expect(again).toEqual(first);
  });

  it('records an object it could not read and goes on', async () => {
    const { store } = memoryStore();
    const { state } = fakeObjects(store, {
      async exportState(_c, name) {
        if (name === 'o002') throw new Error('gone');
        return { tables: {} };
      },
    });
    const got = await snapshotChunk(active(3), state, store, at);
    expect(got.chunk).toMatchObject({ objects: 3, errors: 1 });
    const body = await (await store.get(got.chunk!.key))!.arrayBuffer();
    const text = await new Response(
      new Response(body).body!.pipeThrough(new DecompressionStream('gzip')),
    ).text();
    expect(text.split('\n').map((l) => JSON.parse(l))).toEqual([
      { name: 'o001', state: { tables: {} } },
      { name: 'o002', error: 'gone' },
      { name: 'o003', state: { tables: {} } },
    ]);
  });

  it('takes no more than the cap leaves, and nothing from an empty index', async () => {
    const { store } = memoryStore();
    const { state } = fakeObjects(store);
    expect(
      (await snapshotChunk(active(60), state, store, { ...at, take: 10 })).chunk?.objects,
    ).toBe(10);
    const empty = await snapshotChunk(active(0), state, store, { ...at, n: 5 });
    expect(empty).toEqual({ chunk: null, next: '', more: false });
  });
});

describe('the drill', () => {
  it('passes when the probe holds exactly the rows expected', async () => {
    const probe: DrillProbe = {
      reset: async () => {},
      mark: async () => 'bm',
      labels: async () => ['before'],
    };
    expect(await checkProbe(probe, ['before'])).toEqual({
      ok: true,
      expected: ['before'],
      actual: ['before'],
    });
    // A rewind that left the later row in place, or took the earlier one, fails.
    expect((await checkProbe(probe, ['after', 'before'])).ok).toBe(false);
    expect((await checkProbe({ ...probe, labels: async () => [] }, ['before'])).ok).toBe(false);
  });
});
