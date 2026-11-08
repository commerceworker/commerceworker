import { type AppContext, listAuditLog } from '@commerceworker/application';
import type { AuditEntry, AuditQuery } from '@commerceworker/ports';
import { InMemoryContentStore } from '@commerceworker/test-kit';
import { countingD1 } from '@commerceworker/test-kit/d1';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * The audit log's filters and keyset paging against D1: the same rows, in the same order, as the
 * in-memory store; rows sharing a millisecond neither lost nor repeated at a page's edge; one
 * space read at a time; and each filter served by an index, not a walk of the space's whole log.
 */

const T0 = Date.parse('2026-03-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ids = { newId: () => crypto.randomUUID() };
const clock = { now: () => new Date(T0) };

/** More rows than one page holds, a run of them in one millisecond across a page's edge. */
const ROWS = 130;
const TIED_FROM = 90;
const TIED_TO = 110;

describe('audit log filters and paging on D1', { timeout: 60_000 }, () => {
  const runId = crypto.randomUUID();
  const spaceId = `audit-${runId}`;
  const otherSpace = `audit-other-${runId}`;
  const d1 = createD1Store(testDb);
  const mem = new InMemoryContentStore();
  const d1Ctx: AppContext = { store: d1, clock, ids };
  const memCtx: AppContext = { store: mem, clock, ids };

  const row = (n: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
    // Random within a run of ties, so the id order is not the insertion order.
    id: `${crypto.randomUUID()}-${String(n).padStart(4, '0')}`,
    spaceId,
    environmentId: n % 2 ? 'main' : 'staging',
    actor: n % 3 ? 'usr_ada' : 'usr_grace',
    action: n % 5 ? 'PUT /entries/:id' : 'POST /releases',
    targetType: n % 5 ? 'entry' : 'release',
    targetId: `target-${n % 7}`,
    status: 200,
    at: iso(n >= TIED_FROM && n < TIED_TO ? T0 + TIED_FROM * 1000 : T0 + n * 1000),
    ...over,
  });

  beforeAll(async () => {
    for (let n = 0; n < ROWS; n++) {
      const entry = row(n);
      await d1.audit.append(entry);
      await mem.audit.append(entry);
    }
    const stray = row(1, { spaceId: otherSpace, actor: 'usr_ada', targetId: 'target-1' });
    await d1.audit.append(stray);
    await mem.audit.append(stray);
  });

  async function walk(ctx: AppContext, space: string, query: Parameters<typeof listAuditLog>[2]) {
    const seen: AuditEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await listAuditLog(ctx, space, { ...query, cursor });
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return seen;
  }

  it('walks every row once, newest first, through a run of ties at a page edge', async () => {
    const seen = await walk(d1Ctx, spaceId, { limit: 7 });
    expect(seen).toHaveLength(ROWS);
    expect(new Set(seen.map((e) => e.id)).size).toBe(ROWS);
    const sorted = [...seen].sort(
      (a, b) => b.at.localeCompare(a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    expect(seen.map((e) => e.id)).toEqual(sorted.map((e) => e.id));
  });

  it('reads one statement a page, and a page stops at 100 rows', async () => {
    const counting = countingD1(testDb);
    const ctx: AppContext = { store: createD1Store(counting.d1), clock, ids };
    let page: Awaited<ReturnType<typeof listAuditLog>> | undefined;
    const log = await counting.measure(async () => {
      page = await listAuditLog(ctx, spaceId, { limit: 1000 });
    });
    expect(log.statements).toBe(1);
    expect(page?.items).toHaveLength(100);
    expect(page?.nextCursor).toBeTruthy();
  });

  it.each<[string, Parameters<typeof listAuditLog>[2]]>([
    ['environment', { environmentId: 'staging' }],
    ['actor', { actor: 'usr_grace' }],
    ['action', { action: 'POST /releases' }],
    ['target type', { targetType: 'release' }],
    ['target id', { targetId: 'target-3' }],
    ['target type and id', { targetType: 'entry', targetId: 'target-3' }],
    ['from', { from: iso(T0 + 100_000) }],
    ['to', { to: iso(T0 + 20_000) }],
    ['a range that lands on a run of ties', { from: iso(T0 + 90_000), to: iso(T0 + 90_000) }],
    ['every filter at once', { actor: 'usr_ada', targetType: 'entry', to: iso(T0 + 60_000) }],
  ])('keeps what the in-memory store keeps: %s', async (_name, query) => {
    const onD1 = await walk(d1Ctx, spaceId, { ...query, limit: 9 });
    const inMemory = await walk(memCtx, spaceId, { ...query, limit: 9 });
    expect(onD1.length).toBeGreaterThan(0);
    expect(onD1).toEqual(inMemory);
  });

  it('holds both ends of a range inclusive', async () => {
    const rows = await walk(d1Ctx, spaceId, { from: iso(T0 + 3000), to: iso(T0 + 5000) });
    expect(rows.map((e) => e.at)).toEqual([iso(T0 + 5000), iso(T0 + 4000), iso(T0 + 3000)]);
  });

  it('reads one space: another space’s rows never match, and a cursor crosses nothing', async () => {
    const stray = await listAuditLog(d1Ctx, otherSpace, {});
    expect(stray.items).toHaveLength(1);
    const first = await listAuditLog(d1Ctx, spaceId, { limit: 1 });
    const crossed = await listAuditLog(d1Ctx, otherSpace, { cursor: first.nextCursor });
    expect(crossed.items.map((e) => e.spaceId)).toEqual([otherSpace]);
    const own = await walk(d1Ctx, spaceId, { actor: 'usr_ada', targetId: 'target-1' });
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((e) => e.spaceId === spaceId)).toBe(true);
  });

  it('leaves the next page steady when a newer row arrives between reads', async () => {
    const space = `audit-live-${runId}`;
    for (const n of [1, 2, 3]) await d1.audit.append(row(n, { spaceId: space }));
    const page = await listAuditLog(d1Ctx, space, { limit: 2 });
    await d1.audit.append(row(200, { spaceId: space }));
    const next = await listAuditLog(d1Ctx, space, { limit: 2, cursor: page.nextCursor });
    expect(next.items.map((e) => e.at)).toEqual([iso(T0 + 1000)]);
    expect(next.nextCursor).toBeUndefined();
  });

  describe('the query plan', () => {
    /** The plan SQLite chooses for the statement the store really sends. */
    async function plan(query: AuditQuery): Promise<string> {
      const counting = countingD1(testDb);
      const store = createD1Store(counting.d1);
      const log = await counting.measure(() => store.audit.list(spaceId, query));
      const text = log.sql[0] as string;
      const binds = Array.from(text.matchAll(/\?/g), () => 1);
      const result = await testDb
        .prepare(`EXPLAIN QUERY PLAN ${text}`)
        .bind(...binds)
        .all<{ detail: string }>();
      return result.results.map((r) => r.detail).join('\n');
    }
    const after = { at: iso(T0 + 50_000), id: 'x' };

    it.each<[string, AuditQuery, string]>([
      ['actor', { actor: 'a' }, 'audit_log_by_actor (space_id=? AND actor=?)'],
      [
        'actor, past a cursor',
        { actor: 'a', after },
        'audit_log_by_actor (space_id=? AND actor=? AND (at,id)<(?,?))',
      ],
      [
        'actor in a range',
        { actor: 'a', from: iso(T0), to: iso(T0 + 1) },
        'audit_log_by_actor (space_id=? AND actor=? AND at>? AND at<?)',
      ],
      ['action', { action: 'a' }, 'audit_log_by_action (space_id=? AND action=?)'],
      [
        'action, past a cursor',
        { action: 'a', after },
        'audit_log_by_action (space_id=? AND action=? AND (at,id)<(?,?))',
      ],
      ['target id', { targetId: 'a' }, 'audit_log_by_target (space_id=? AND target_id=?)'],
      [
        'target type and id, past a cursor',
        { targetType: 'a', targetId: 'b', after },
        'audit_log_by_target (space_id=? AND target_id=? AND (at,id)<(?,?))',
      ],
    ])('reads %s as a range of an index, with no sort', async (_name, query, index) => {
      const chosen = await plan(query);
      expect(chosen).toContain(index);
      expect(chosen).not.toContain('TEMP B-TREE');
    });

    it.each<[string, AuditQuery, string]>([
      ['nothing', {}, 'audit_log_by_space (space_id=?)'],
      ['a cursor', { after }, 'audit_log_by_space (space_id=? AND at<?)'],
      [
        'a date range',
        { from: iso(T0), to: iso(T0 + 1) },
        'audit_log_by_space (space_id=? AND at>? AND at<?)',
      ],
    ])('reads %s through the space index, in time order', async (_name, query, index) => {
      expect(await plan(query)).toContain(index);
    });
  });
});
