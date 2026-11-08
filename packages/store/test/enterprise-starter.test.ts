import type { AppContext } from '@commerceworker/application';
import { createSpace } from '@commerceworker/application';
import type { Clock, IdGenerator } from '@commerceworker/ports';
import { ENTERPRISE_PHASES, enterpriseSpaceInput, runEnterprisePhase } from '@commerceworker/seed';
import { FakeBlobStore } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * The enterprise starter installs in the background, one phase per bulk job chunk, each chunk on
 * its own queue consumer invocation. An invocation gets 1,000 D1 queries (a `batch()` counts as
 * one) on the default limits, so every phase must fit with room for the chunk's own claim,
 * completion and outbox bookkeeping. This runs every phase against real D1, counts its calls,
 * and holds each under the budget; then reruns them all, as a retried chunk would, and checks a
 * rerun adds nothing and costs less. A phase that grows past the budget splits in two.
 */
const BUDGET = 800;

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

const clock: Clock = { now: () => new Date('2026-11-01T09:00:00.000Z') };
const ids: IdGenerator = { newId: () => crypto.randomUUID() };

describe('the enterprise starter on D1', () => {
  it('fits every phase in one invocation’s D1 budget, and a rerun costs less', {
    timeout: 600_000,
  }, async () => {
    const spaceId = `ent-${crypto.randomUUID().slice(0, 8)}`;
    const counter = counting(testDb);
    const ctx: AppContext = { store: createD1Store(counter.db), clock, ids };
    const blob = new FakeBlobStore();
    const scope = { spaceId, environmentId: 'main' };
    await createSpace(
      ctx,
      enterpriseSpaceInput({ spaceId, name: 'Aldermoor', defaultLocale: 'en-US' }),
    );

    const costs: Record<string, [number, number]> = {};
    for (const phase of ENTERPRISE_PHASES) {
      const before = counter.calls();
      await runEnterprisePhase(ctx, scope, phase.id, { blob });
      costs[phase.id] = [counter.calls() - before, 0];
    }
    for (const phase of ENTERPRISE_PHASES) {
      const before = counter.calls();
      await runEnterprisePhase(ctx, scope, phase.id, { blob });
      (costs[phase.id] as [number, number])[1] = counter.calls() - before;
    }
    console.info(
      `enterprise D1 calls per phase (install, rerun):\n${Object.entries(costs)
        .map(([id, [a, b]]) => `  ${id}: ${a}, ${b}`)
        .join('\n')}`,
    );
    for (const [id, [install, rerun]] of Object.entries(costs)) {
      expect(install, id).toBeLessThan(BUDGET);
      expect(rerun, id).toBeLessThanOrEqual(install);
    }
  });
});
