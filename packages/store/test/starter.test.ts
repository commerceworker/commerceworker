import type { AppContext } from '@commerceworker/application';
import { listPreviewEntries } from '@commerceworker/application';
import type { Clock, IdGenerator } from '@commerceworker/ports';
import { createSpaceWithStarter, installStarter } from '@commerceworker/seed';
import { FakeBlobStore } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * The sample starter runs inside the `POST /spaces` request, so what it costs in D1 calls is a
 * design limit, not a detail: a Worker invocation gets 1,000 D1 queries (a `batch()` counts as one)
 * on the default limits. This measures the real store's calls for a full install and for the
 * retry, and holds them under a budget that leaves the request room for its auth, audit and outbox
 * relay. If the starter grows past it, the install belongs in a background job instead.
 */
const BUDGET = 600;

/** Wraps the D1 binding to count each call that reaches the database: one per query or batch. */
function counting(db: D1Database): { db: D1Database; calls: () => number } {
  let calls = 0;
  const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        if (prop === 'bind') {
          return (...args: unknown[]) => wrapStatement(value.apply(target, args));
        }
        if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
          return (...args: unknown[]) => {
            calls += 1;
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'prepare') return (sql: string) => wrapStatement(value.call(target, sql));
      if (prop === 'batch' || prop === 'exec') {
        return (...args: unknown[]) => {
          calls += 1;
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  return { db: wrapped, calls: () => calls };
}

const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const ids: IdGenerator = { newId: () => crypto.randomUUID() };

describe('the sample starter on D1', () => {
  it('installs within the per-request D1 query budget, and a retry costs less', async () => {
    const spaceId = `starter-${crypto.randomUUID().slice(0, 8)}`;
    const counter = counting(testDb);
    const ctx: AppContext = { store: createD1Store(counter.db), clock, ids };
    const blob = new FakeBlobStore();

    await createSpaceWithStarter(
      ctx,
      { spaceId, name: 'Starter', defaultLocale: 'en-US', starter: 'sample' },
      { blob },
    );
    const install = counter.calls();
    const scope = { spaceId, environmentId: 'main' };
    expect((await listPreviewEntries(ctx, scope, { locale: 'en-US', limit: 1000 })).length).toBe(
      39,
    );

    const beforeRetry = counter.calls();
    await installStarter(ctx, scope, { blob });
    const retry = counter.calls() - beforeRetry;

    console.info(`starter D1 calls: install ${install}, retry ${retry}`);
    expect(install).toBeLessThan(BUDGET);
    expect(retry).toBeLessThan(install);
  });
});
