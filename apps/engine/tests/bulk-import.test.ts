import { introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { BULK_CHUNK_ROWS, csvLine } from '@commerceworker/core';
import { describe, expect, it } from 'vitest';
import { bulkJobStore } from '../src/wire';

const jobs = bulkJobStore(env);
async function job(id: string, rows?: string) {
  const sourceKey = `imports/${id}/source.csv`;
  if (rows !== undefined) await env.DOCS.put(sourceKey, rows);
  await jobs.create({
    id,
    kind: 'stock',
    checkOnly: false,
    fileName: 'stock.csv',
    sourceKey,
    createdBy: 'test',
    createdAt: 1,
  });
}
async function run(id: string) {
  await using instance = await introspectWorkflowInstance(env.BULK_IMPORT, id);
  await env.BULK_IMPORT.create({ id, params: {} });
  await instance.waitForStatus('complete');
  return jobs.get(id);
}

describe('bulk import Workflow', () => {
  it('reads across chunk boundaries and writes all refusals in order', async () => {
    const id = 'blk_report';
    const count = BULK_CHUNK_ROWS + 3;
    await job(
      id,
      csvLine(['sku', 'stock']) +
        Array.from({ length: count }, (_, i) => csvLine([`unknown-${i}`, 3])).join(''),
    );
    const result = await run(id);
    expect(result).toMatchObject({ status: 'done', failed: count, applied: 0, nextRow: count + 2 });
    expect(result?.errors.length).toBe(100);
    const report = await env.DOCS.get(result!.reportKey!);
    expect(await report?.text()).toBe(
      csvLine(['row', 'error']) +
        Array.from({ length: count }, (_, i) =>
          csvLine([i + 2, `No such product: unknown-${i}.`]),
        ).join(''),
    );
    expect((await env.DOCS.list({ prefix: `imports/${id}/work/` })).objects).toHaveLength(0);
  });
  it('resumes after a saved byte offset and applies only the remaining stock row', async () => {
    const id = 'blk_resume';
    const sku = 'BULK-RESUME';
    await env.DB.prepare(
      'INSERT INTO products (sku, name, price, cost, stock) VALUES (?, ?, 1, 0, 5)',
    )
      .bind(sku, sku)
      .run();
    const first = csvLine(['sku', 'stock']) + csvLine(['missing-é', 3]);
    const offset = new TextEncoder().encode(first).length;
    await job(id, first + csvLine([sku, 17]));
    await jobs.start(id, 2);
    await jobs.advance(
      id,
      0,
      { header: ['sku', 'stock'], offset, nextRow: 3, applied: 1, failed: 0, errors: [] },
      3,
    );
    expect(await run(id)).toMatchObject({
      status: 'done',
      applied: 2,
      failed: 0,
      nextRow: 4,
      reportKey: null,
    });
    expect(
      await env.DB.prepare('SELECT stock FROM products WHERE sku = ?').bind(sku).first('stock'),
    ).toBe(17);
  });
  it('records missing and malformed uploads and respects a cancelled job', async () => {
    await job('blk_missing');
    expect(await run('blk_missing')).toMatchObject({
      status: 'failed',
      error: 'The uploaded file is missing.',
    });
    await job('blk_bad', 'sku,stock\r\n"unfinished');
    expect(await run('blk_bad')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('unterminated'),
    });
    await job('blk_cancel');
    await jobs.finish('blk_cancel', 'cancelled', 2);
    expect(await run('blk_cancel')).toMatchObject({ status: 'cancelled', updatedAt: 2 });
  });
});
