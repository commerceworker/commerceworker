import type { ContentStore } from '@commerceworker/ports';
import { InMemoryContentStore } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

// The cron heartbeat's merge rules, proven on D1 and held to the same contract by the in-memory
// store the application tests use. The file shares one database: each test names its own jobs.
const stores: [string, () => ContentStore][] = [
  ['D1', () => createD1Store(testDb)],
  ['in-memory', () => new InMemoryContentStore()],
];

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-01T10:01:00.000Z';
const T2 = '2026-11-01T10:02:00.000Z';

describe.each(stores)('scheduler jobs (%s)', (name, make) => {
  const job = (n: string) => `${name}-${n}-${crypto.randomUUID()}`;
  const find = async (store: ContentStore, j: string) =>
    (await store.schedulerJobs.list()).find((r) => r.job === j);

  it('records a success, then a failure that keeps the last success', async () => {
    const store = make();
    const j = job('relay');
    await store.schedulerJobs.record([{ job: j, at: T0 }]);
    expect(await find(store, j)).toEqual({ job: j, lastRunAt: T0, lastSuccessAt: T0 });

    await store.schedulerJobs.record([{ job: j, at: T1, error: 'queue unavailable' }]);
    expect(await find(store, j)).toEqual({
      job: j,
      lastRunAt: T1,
      lastSuccessAt: T0,
      lastErrorAt: T1,
      lastError: 'queue unavailable',
    });

    // Recovery keeps the last error for the admin to read.
    await store.schedulerJobs.record([{ job: j, at: T2 }]);
    expect(await find(store, j)).toEqual({
      job: j,
      lastRunAt: T2,
      lastSuccessAt: T2,
      lastErrorAt: T1,
      lastError: 'queue unavailable',
    });
  });

  it('never moves a timestamp back when a slow tick lands after the next one', async () => {
    const store = make();
    const j = job('late');
    await store.schedulerJobs.record([{ job: j, at: T2 }]);
    await store.schedulerJobs.record([{ job: j, at: T1, error: 'late failure' }]);
    await store.schedulerJobs.record([{ job: j, at: T0 }]);
    // The late failure is still the newest failure, so it is kept; the runs and success are not
    // moved back to it.
    expect(await find(store, j)).toEqual({
      job: j,
      lastRunAt: T2,
      lastSuccessAt: T2,
      lastErrorAt: T1,
      lastError: 'late failure',
    });
    // A retried write of the same run changes nothing.
    await store.schedulerJobs.record([{ job: j, at: T1, error: 'late failure' }]);
    expect((await find(store, j))?.lastRunAt).toBe(T2);
  });

  it('writes many jobs in one call, under the parameter cap', async () => {
    const store = make();
    // 5 columns a row: 40 rows is 200 parameters, so the insert must split.
    const many = Array.from({ length: 40 }, (_, i) => ({ job: job(`many-${i}`), at: T0 }));
    await store.schedulerJobs.record(many);
    const listed = new Set((await store.schedulerJobs.list()).map((r) => r.job));
    for (const r of many) expect(listed.has(r.job)).toBe(true);
  });
});
