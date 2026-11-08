import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AppContext, listAuditLog, recordAudit } from '../src/index';

function makeContext(): { ctx: AppContext; clock: FixedClock } {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'shop', defaultLocale: 'en-US', locales: ['en-US'] });
  const clock = new FixedClock();
  return { ctx: { store, clock, ids: new SequenceIdGenerator('a') }, clock };
}

describe('audit log', () => {
  let ctx: AppContext;
  let clock: FixedClock;

  beforeEach(() => {
    ({ ctx, clock } = makeContext());
  });

  it('stamps id + timestamp from the injected generators', async () => {
    const entry = await recordAudit(ctx, {
      spaceId: 'shop',
      environmentId: 'main',
      actor: 'cma',
      action: 'POST /spaces/:space/environments/:env/entries',
      targetId: 'entry-1',
      status: 201,
    });
    expect(entry.id).toBe('a-1');
    expect(entry.at).toBe('2026-01-01T00:00:00.000Z');
    expect(entry.actor).toBe('cma');
  });

  it('returns entries newest first', async () => {
    await recordAudit(ctx, { spaceId: 'shop', actor: 'cma', action: 'a', status: 200 });
    clock.advance(1000);
    await recordAudit(ctx, { spaceId: 'shop', actor: 'cma', action: 'b', status: 200 });
    const { items } = await listAuditLog(ctx, 'shop');
    expect(items.map((e) => e.action)).toEqual(['b', 'a']);
  });

  it('isolates entries by space', async () => {
    await recordAudit(ctx, { spaceId: 'shop', actor: 'cma', action: 'a', status: 200 });
    await recordAudit(ctx, { spaceId: 'other', actor: 'cma', action: 'b', status: 200 });
    expect((await listAuditLog(ctx, 'shop')).items).toHaveLength(1);
    expect((await listAuditLog(ctx, 'other')).items).toHaveLength(1);
  });

  it('filters by environment and honors limit', async () => {
    await recordAudit(ctx, {
      spaceId: 'shop',
      environmentId: 'main',
      actor: 'cma',
      action: 'a',
      status: 200,
    });
    await recordAudit(ctx, {
      spaceId: 'shop',
      environmentId: 'staging',
      actor: 'cma',
      action: 'b',
      status: 200,
    });
    await recordAudit(ctx, {
      spaceId: 'shop',
      environmentId: 'main',
      actor: 'cma',
      action: 'c',
      status: 200,
    });

    const main = await listAuditLog(ctx, 'shop', { environmentId: 'main' });
    expect(main.items.map((e) => e.action)).toEqual(['c', 'a']);

    const limited = await listAuditLog(ctx, 'shop', { limit: 1 });
    expect(limited.items).toHaveLength(1);
    expect(limited.items[0]?.action).toBe('c');
  });

  describe('filters', () => {
    const add = (over: Partial<Parameters<typeof recordAudit>[1]>) =>
      recordAudit(ctx, { spaceId: 'shop', actor: 'cma', action: 'a', status: 200, ...over });

    beforeEach(async () => {
      await add({
        actor: 'usr_ada',
        action: 'PUT /entries/:id',
        targetType: 'entry',
        targetId: 'e1',
      });
      clock.advance(1000);
      await add({
        actor: 'usr_ada',
        action: 'POST /releases',
        targetType: 'release',
        targetId: 'r1',
      });
      clock.advance(1000);
      await add({
        actor: 'usr_grace',
        action: 'PUT /entries/:id',
        targetType: 'entry',
        targetId: 'e2',
      });
      await add({ spaceId: 'other', actor: 'usr_ada', targetType: 'entry', targetId: 'e1' });
    });

    const ids = async (query: Parameters<typeof listAuditLog>[2]) =>
      (await listAuditLog(ctx, 'shop', query)).items.map((e) => e.targetId);

    it('narrows by actor, action, target type and target id, together', async () => {
      expect(await ids({ actor: 'usr_ada' })).toEqual(['r1', 'e1']);
      expect(await ids({ action: 'PUT /entries/:id' })).toEqual(['e2', 'e1']);
      expect(await ids({ targetType: 'entry' })).toEqual(['e2', 'e1']);
      expect(await ids({ targetId: 'e1' })).toEqual(['e1']);
      expect(await ids({ actor: 'usr_ada', targetType: 'entry' })).toEqual(['e1']);
      expect(await ids({ actor: 'nobody' })).toEqual([]);
    });

    it('never reaches another space', async () => {
      const rows = await listAuditLog(ctx, 'shop', { targetId: 'e1' });
      expect(rows.items.map((e) => e.spaceId)).toEqual(['shop']);
    });

    it('treats an empty value as no filter', async () => {
      expect(await ids({ actor: '', action: '', from: '', to: '', cursor: '' })).toHaveLength(3);
    });

    it('holds a range inclusive at both ends, whatever offset names it', async () => {
      expect(await ids({ from: '2026-01-01T00:00:01.000Z' })).toEqual(['e2', 'r1']);
      expect(await ids({ to: '2026-01-01T00:00:01.000Z' })).toEqual(['r1', 'e1']);
      expect(
        await ids({ from: '2026-01-01T02:00:01+02:00', to: '2026-01-01T02:00:01+02:00' }),
      ).toEqual(['r1']);
    });

    it('reads a date as the whole UTC day', async () => {
      expect(await ids({ from: '2026-01-01', to: '2026-01-01' })).toHaveLength(3);
      expect(await ids({ to: '2025-12-31' })).toEqual([]);
      expect(await ids({ from: '2026-01-02' })).toEqual([]);
    });

    it.each([
      ['from', 'yesterday'],
      ['to', '1'],
      ['from', '2026-02-31'],
      ['to', '2026-13-01'],
      ['from', '2026-01-01T00:00:00'],
    ])('refuses a %s of %s', async (field, value) => {
      await expect(listAuditLog(ctx, 'shop', { [field]: value })).rejects.toMatchObject({
        name: 'ValidationError',
        issues: [expect.objectContaining({ field })],
      });
    });

    it('refuses a range that ends before it starts', async () => {
      await expect(
        listAuditLog(ctx, 'shop', { from: '2026-01-02', to: '2026-01-01' }),
      ).rejects.toMatchObject({ issues: [expect.objectContaining({ field: 'from' })] });
    });
  });

  describe('paging', () => {
    const fill = async (count: number, stepMs: number) => {
      for (let n = 0; n < count; n++) {
        await recordAudit(ctx, { spaceId: 'shop', actor: 'cma', action: `a${n}`, status: 200 });
        clock.advance(stepMs);
      }
    };

    it('walks the log by cursor, each row once, and stops', async () => {
      await fill(5, 1000);
      const first = await listAuditLog(ctx, 'shop', { limit: 2 });
      const second = await listAuditLog(ctx, 'shop', { limit: 2, cursor: first.nextCursor });
      const third = await listAuditLog(ctx, 'shop', { limit: 2, cursor: second.nextCursor });
      expect([...first.items, ...second.items, ...third.items].map((e) => e.action)).toEqual([
        'a4',
        'a3',
        'a2',
        'a1',
        'a0',
      ]);
      expect(third.nextCursor).toBeUndefined();
    });

    it('gives no cursor when a page ends exactly at the last row', async () => {
      await fill(2, 1000);
      expect((await listAuditLog(ctx, 'shop', { limit: 2 })).nextCursor).toBeUndefined();
    });

    it('keeps rows that share a millisecond across a page edge', async () => {
      await fill(5, 0);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listAuditLog(ctx, 'shop', { limit: 2, cursor });
        seen.push(...page.items.map((e) => e.action));
        cursor = page.nextCursor;
      } while (cursor);
      expect([...seen].sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
    });

    it('holds a page to the largest a client may ask for', async () => {
      await fill(101, 1);
      const page = await listAuditLog(ctx, 'shop', { limit: 5000 });
      expect(page.items).toHaveLength(100);
      expect(page.nextCursor).toBeDefined();
    });

    it.each([
      ['not base64', '%%%'],
      ['not the shape', btoa(encodeURIComponent(JSON.stringify(['x'])))],
      ['a bad time', btoa(encodeURIComponent(JSON.stringify(['soon', 'id'])))],
      ['no id', btoa(encodeURIComponent(JSON.stringify(['2026-01-01T00:00:00.000Z', ''])))],
    ])('refuses a cursor that is %s', async (_name, cursor) => {
      await expect(listAuditLog(ctx, 'shop', { cursor })).rejects.toMatchObject({
        name: 'ValidationError',
        issues: [expect.objectContaining({ field: 'cursor' })],
      });
    });
  });
});
