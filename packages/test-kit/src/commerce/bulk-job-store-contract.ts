/**
 * What every `BulkJobStore` does, run against the in-memory store here and the D1 store in
 * packages/db/test.
 */
import type { BulkJobStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const job = (id: string, createdAt = 1) => ({
  id,
  kind: 'stock' as const,
  checkOnly: false,
  fileName: 'stock.csv',
  sourceKey: `imports/${id}/source.csv`,
  createdBy: 'ann@example.com',
  createdAt,
});

export function describeBulkJobStoreContract(name: string, make: () => Promise<BulkJobStore>) {
  describe(`${name} bulk job store`, () => {
    it('records a job queued, and lists the newest first', async () => {
      const s = await make();
      await s.create(job('blk_bj_old', 10));
      await s.create(job('blk_bj_new', 20));
      expect(await s.get('blk_bj_new')).toMatchObject({
        status: 'queued',
        header: [],
        offset: 0,
        nextRow: 1,
        applied: 0,
        errors: [],
        reportKey: null,
        updatedAt: 20,
      });
      const ids = (await s.list(50)).map((j) => j.id).filter((id) => id.startsWith('blk_bj_'));
      expect(ids.indexOf('blk_bj_new')).toBeLessThan(ids.indexOf('blk_bj_old'));
      expect(await s.get('blk_bj_none')).toBeUndefined();
    });

    it('starts once, and adds a chunk only at the offset it began at', async () => {
      const s = await make();
      await s.create(job('blk_bj_run'));
      expect(await s.start('blk_bj_run', 2)).toBe(true);
      expect(await s.start('blk_bj_run', 3)).toBe(false);
      const chunk = {
        header: ['sku', 'stock'],
        offset: 120,
        nextRow: 12,
        applied: 9,
        failed: 1,
        errors: [{ row: 5, error: 'No such product: X.' }],
      };
      expect(await s.advance('blk_bj_run', 0, chunk, 4)).toBe(true);
      // The same step again: already past offset 0, so nothing is added twice.
      expect(await s.advance('blk_bj_run', 0, chunk, 5)).toBe(false);
      expect(
        await s.advance(
          'blk_bj_run',
          120,
          { offset: 200, nextRow: 20, applied: 7, failed: 1, errors: [{ row: 3, error: 'early' }] },
          6,
        ),
      ).toBe(true);
      expect(await s.get('blk_bj_run')).toMatchObject({
        header: ['sku', 'stock'],
        offset: 200,
        nextRow: 20,
        applied: 16,
        failed: 2,
        errors: [
          { row: 3, error: 'early' },
          { row: 5, error: 'No such product: X.' },
        ],
      });
    });

    it('keeps the first hundred errors by row', async () => {
      const s = await make();
      await s.create(job('blk_bj_many'));
      await s.start('blk_bj_many', 2);
      const errors = Array.from({ length: 120 }, (_, i) => ({ row: 200 - i, error: 'bad' }));
      await s.advance(
        'blk_bj_many',
        0,
        { offset: 9, nextRow: 201, applied: 0, failed: 120, errors },
        3,
      );
      const kept = (await s.get('blk_bj_many'))!.errors;
      expect(kept).toHaveLength(100);
      expect(kept[0]!.row).toBe(81);
      expect((await s.get('blk_bj_many'))!.failed).toBe(120);
    });

    it('ends once, adding nothing after', async () => {
      const s = await make();
      await s.create(job('blk_bj_end'));
      await s.start('blk_bj_end', 2);
      expect(
        await s.finish('blk_bj_end', 'done', 9, { reportKey: 'imports/blk_bj_end/report.csv' }),
      ).toBe(true);
      expect(await s.finish('blk_bj_end', 'failed', 10, { error: 'late' })).toBe(false);
      expect(
        await s.advance(
          'blk_bj_end',
          0,
          { offset: 1, nextRow: 2, applied: 1, failed: 0, errors: [] },
          11,
        ),
      ).toBe(false);
      expect(await s.get('blk_bj_end')).toMatchObject({
        status: 'done',
        reportKey: 'imports/blk_bj_end/report.csv',
        error: null,
        updatedAt: 9,
      });
      // A queued job can be cancelled before it starts.
      await s.create(job('blk_bj_cancel'));
      expect(await s.finish('blk_bj_cancel', 'cancelled', 3)).toBe(true);
      expect(await s.start('blk_bj_cancel', 4)).toBe(false);
    });
  });
}
