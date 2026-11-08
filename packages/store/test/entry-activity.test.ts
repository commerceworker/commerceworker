import { type AppContext, listEntryActivity } from '@commerceworker/application';
import type { AuditDetail } from '@commerceworker/domain';
import type { AuditEntry, AuditQuery } from '@commerceworker/ports';
import { InMemoryContentStore } from '@commerceworker/test-kit';
import { countingD1 } from '@commerceworker/test-kit/d1';
import { beforeAll, describe, expect, it } from 'vitest';
import migration from '../migrations/0033_audit_log_entries.sql?raw';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * An entry's activity against D1: the audit log read through `audit_log_entries`, which the 0033
 * trigger fills as each row is appended. The same rows, in the same order, as the in-memory
 * store; rows sharing a millisecond neither lost nor repeated at a page's edge; one environment
 * and space at a time; one statement a page, a range of the entry index with no sort. And a row
 * appended by code that has never heard of the table (deployed code, during a deploy or after a
 * rollback) is indexed all the same, as the backfill indexes rows from before it.
 */

const T0 = Date.parse('2026-04-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ids = { newId: () => crypto.randomUUID() };
const clock = { now: () => new Date(T0) };

/** More rows than a page holds, and a run of them in one millisecond across a page's edge. */
const ROWS = 200;
const TIED_FROM = 60;
const TIED_TO = 75;

const detailOf = (...entryIds: string[]): AuditDetail => ({
  entries: entryIds.map((entryId) => ({
    entryId,
    contentType: 'article',
    kind: 'updated',
    version: 2,
    paths: ['fields.title'],
    locales: [],
  })),
});

describe('an entry’s activity on D1', { timeout: 60_000 }, () => {
  const runId = crypto.randomUUID();
  const spaceId = `activity-${runId}`;
  const entry = `e-${runId}`;
  const neighbour = `n-${runId}`;
  const d1 = createD1Store(testDb);
  const mem = new InMemoryContentStore();
  const d1Ctx: AppContext = { store: d1, clock, ids };
  const memCtx: AppContext = { store: mem, clock, ids };
  const scope = { spaceId, environmentId: 'main' };

  /** About the entry by target (n % 3 = 0), by detail beside another entry (1), or not at all (2). */
  const row = (n: number, over: Partial<AuditEntry> = {}): AuditEntry => {
    const kind = n % 3;
    return {
      // Random within a run of ties, so the id order is not the insertion order.
      id: `${crypto.randomUUID()}-${String(n).padStart(4, '0')}`,
      spaceId,
      environmentId: n % 7 === 0 ? 'staging' : 'main',
      actor: 'usr_ada',
      action: kind === 1 ? 'MCP agent_review_approve' : 'PUT /entries/:id',
      targetType: kind === 1 ? 'agent_review' : 'entry',
      targetId: kind === 0 ? entry : kind === 1 ? `review-${n}` : neighbour,
      status: 200,
      at: iso(n >= TIED_FROM && n < TIED_TO ? T0 + TIED_FROM * 1000 : T0 + n * 1000),
      // Some target rows name the entry in detail too: still one row.
      ...(kind === 1
        ? { detail: detailOf(neighbour, entry) }
        : kind === 0 && n % 2
          ? { detail: detailOf(entry) }
          : {}),
      ...over,
    };
  };

  beforeAll(async () => {
    for (let n = 0; n < ROWS; n++) {
      const r = row(n);
      await d1.audit.append(r);
      await mem.audit.append(r);
    }
    // Another space with the same entry id.
    const stray = row(0, { spaceId: `other-${runId}`, environmentId: 'main' });
    await d1.audit.append(stray);
    await mem.audit.append(stray);
  });

  async function walk(ctx: AppContext, s = scope, id = entry, limit = 9) {
    const seen: AuditEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await listEntryActivity(ctx, s, id, { limit, cursor });
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return seen;
  }

  it('keeps what the in-memory store keeps, newest first, through a run of ties', async () => {
    const onD1 = await walk(d1Ctx);
    const inMemory = await walk(memCtx);
    // Two of every three rows are about it, minus the staging ones.
    expect(onD1.length).toBeGreaterThan(70);
    expect(new Set(onD1.map((e) => e.id)).size).toBe(onD1.length);
    expect(onD1).toEqual(inMemory);
    expect(onD1.every((e) => e.environmentId === 'main' && e.spaceId === spaceId)).toBe(true);
    expect(onD1.some((e) => e.targetType === 'agent_review')).toBe(true);
  });

  it('reads its own environment and space only', async () => {
    const staging = await walk(d1Ctx, { ...scope, environmentId: 'staging' });
    expect(staging.length).toBeGreaterThan(0);
    expect(staging).toEqual(await walk(memCtx, { ...scope, environmentId: 'staging' }));
    expect(staging.every((e) => e.environmentId === 'staging')).toBe(true);
    const other = await listEntryActivity(d1Ctx, { ...scope, spaceId: `other-${runId}` }, entry);
    expect(other.items.map((e) => e.spaceId)).toEqual([`other-${runId}`]);
    // A cursor from one space crosses into nothing of another's.
    const first = await listEntryActivity(d1Ctx, scope, entry, { limit: 1 });
    const crossed = await listEntryActivity(d1Ctx, { ...scope, spaceId: `other-${runId}` }, entry, {
      cursor: first.nextCursor,
    });
    expect(crossed.items.every((e) => e.spaceId === `other-${runId}`)).toBe(true);
  });

  it('reads one statement a page, and a page stops at 100 rows', async () => {
    const counting = countingD1(testDb);
    const ctx: AppContext = { store: createD1Store(counting.d1), clock, ids };
    let page: Awaited<ReturnType<typeof listEntryActivity>> | undefined;
    const log = await counting.measure(async () => {
      page = await listEntryActivity(ctx, scope, entry, { limit: 1000 });
    });
    expect(log.statements).toBe(1);
    expect(page?.items).toHaveLength(100);
    expect(page?.nextCursor).toBeTruthy();
  });

  it('reads a page as a range of the entry index, with no sort', async () => {
    const after = { at: iso(T0 + 50_000), id: 'x' };
    for (const query of [{}, { after }] satisfies Partial<AuditQuery>[]) {
      const counting = countingD1(testDb);
      const store = createD1Store(counting.d1);
      const log = await counting.measure(() =>
        store.audit.list(spaceId, { environmentId: 'main', entryId: entry, ...query }),
      );
      const text = log.sql[0] as string;
      const binds = Array.from(text.matchAll(/\?/g), () => 1);
      const plan = (
        await testDb
          .prepare(`EXPLAIN QUERY PLAN ${text}`)
          .bind(...binds)
          .all<{ detail: string }>()
      ).results
        .map((r) => r.detail)
        .join('\n');
      expect(plan).toContain(
        'audit_log_entries_by_entry (space_id=? AND environment_id=? AND entry_id=?',
      );
      expect(plan).not.toContain('TEMP B-TREE');
    }
  });

  it('indexes a row appended by code that never names the table', async () => {
    const id = `raw-${runId}`;
    // As deployed code writes it, through its own insert: the trigger does the rest.
    await testDb
      .prepare(
        'INSERT INTO audit_log (id, space_id, environment_id, actor, action, target_type, target_id, status, at, detail) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        spaceId,
        'main',
        'usr_grace',
        'MCP entries_duplicate',
        'entry',
        neighbour,
        200,
        T0 + 500_000,
        JSON.stringify(detailOf(entry)),
      )
      .run();
    const [newest] = (await listEntryActivity(d1Ctx, scope, entry, { limit: 1 })).items;
    expect(newest?.id).toBe(id);
    const [theirs] = (await listEntryActivity(d1Ctx, scope, neighbour, { limit: 1 })).items;
    expect(theirs?.id).toBe(id);
  });

  it.each([
    ['not JSON', 'not json', []],
    [
      'entries of the wrong shape',
      '{"entries":["x",1,null,{"entryId":5},{"entryId":"named"}]}',
      ['named'],
    ],
    ['no entries', '{"entries":"x"}', []],
  ])(
    'never fails an append over a detail that is %s, and indexes what it can',
    async (_name, detail, named) => {
      const id = `bad-${crypto.randomUUID()}`;
      const fresh = `f-${runId}`;
      await testDb
        .prepare(
          'INSERT INTO audit_log (id, space_id, environment_id, actor, action, target_type, target_id, status, at, detail) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(id, spaceId, 'main', 'usr_ada', 'PUT', 'entry', fresh, 200, T0, detail)
        .run();
      const { results } = await testDb
        .prepare('SELECT entry_id FROM audit_log_entries WHERE audit_id = ? ORDER BY entry_id')
        .bind(id)
        .all<{ entry_id: string }>();
      expect(results.map((r) => r.entry_id)).toEqual([fresh, ...named].sort());
    },
  );

  it('backfills the rows written before it, once', async () => {
    const space = `backfill-${runId}`;
    const target = row(0, { spaceId: space, environmentId: 'main', targetId: 'e-old' });
    const named = row(1, { spaceId: space, detail: detailOf('e-old', 'e-other') });
    // Before #149: a target and no detail.
    const bare = row(3, { spaceId: space, targetId: 'e-old' });
    for (const r of [target, named, bare]) await d1.audit.append(r);
    // As the rows were before the migration: not indexed.
    await testDb.prepare('DELETE FROM audit_log_entries WHERE space_id = ?').bind(space).run();
    expect(
      (await listEntryActivity(d1Ctx, { spaceId: space, environmentId: 'main' }, 'e-old')).items,
    ).toEqual([]);

    const backfill = migration
      .slice(migration.indexOf('END;') + 'END;'.length)
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean);
    expect(backfill).toHaveLength(2);
    for (const _ of [1, 2]) {
      for (const statement of backfill) await testDb.prepare(statement).run();
    }

    const old = await listEntryActivity(d1Ctx, { spaceId: space, environmentId: 'main' }, 'e-old');
    expect(old.items.map((e) => e.id).sort()).toEqual([target.id, named.id, bare.id].sort());
    const other = await listEntryActivity(
      d1Ctx,
      { spaceId: space, environmentId: 'main' },
      'e-other',
    );
    expect(other.items.map((e) => e.id)).toEqual([named.id]);
  });
});
