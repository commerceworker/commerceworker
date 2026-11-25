import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { applyBulkRows, readBulkChunk } from '@commerceworker/application/commerce';
import {
  BULK_CHUNK_ROWS,
  BULK_MAX_BYTES,
  BULK_MAX_ROWS,
  csvLine,
  csvRecords,
} from '@commerceworker/core';
import {
  bulkJobStore,
  companyDirectory,
  inventoryStore,
  priceBookStore,
  pricingStore,
} from './wire';

type File = { key: string; size: number };
const csvMetadata = { httpMetadata: { contentType: 'text/csv; charset=utf-8' } };
const partName = (offset: number) => String(offset).padStart(10, '0');

// Stream report parts in file order. R2 needs the content length before the first byte.
async function joinFiles(bucket: R2Bucket, key: string, files: File[], header = '') {
  const bytes = new TextEncoder().encode(header);
  const size = files.reduce((n, f) => n + f.size, bytes.length);
  const stream = new FixedLengthStream(size);
  async function write() {
    try {
      if (bytes.length) {
        const writer = stream.writable.getWriter();
        try {
          await writer.write(bytes);
        } finally {
          writer.releaseLock();
        }
      }
      for (const file of files) {
        const object = await bucket.get(file.key);
        if (!object) throw new Error('Missing import report part');
        await object.body.pipeTo(stream.writable, { preventClose: true });
      }
      await stream.writable.close();
    } catch (err) {
      await stream.writable.abort(err);
      throw err;
    }
  }
  await Promise.all([bucket.put(key, stream.readable, csvMetadata), write()]);
  return { key, size };
}

export class BulkImport extends WorkflowEntrypoint<Env, Record<string, never>> {
  override async run(event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
    const id = event.instanceId;
    const jobs = bulkJobStore(this.env);
    const bucket = this.env.DOCS;
    const prefix = `imports/${id}/work/`;
    const parts = `${prefix}parts/`;
    try {
      const start = await step.do('start', async () => {
        await jobs.start(id, Date.now());
        const job = await jobs.get(id);
        if (!job) throw new Error('Import job does not exist');
        const source = job.status === 'running' ? await bucket.head(job.sourceKey) : null;
        return { offset: job.offset, source: source && { etag: source.etag, size: source.size } };
      });
      let offset = start.offset;
      let error: string | null = null;
      for (;;) {
        const chunk: { done: boolean; offset: number; error?: string } = await step.do(
          `read at ${offset}`,
          async () => {
            const job = await jobs.get(id);
            if (job?.status !== 'running') return { done: true, offset };
            // A previous attempt committed its progress before the Workflow checkpoint.
            if (job.offset !== offset) return { done: false, offset: job.offset };
            const file = start.source;
            if (!file) return { done: true, offset, error: 'The uploaded file is missing.' };
            if (file.size > BULK_MAX_BYTES)
              return { done: true, offset, error: 'The file exceeds the 20 MiB import limit.' };
            if (offset === file.size && job.header.length) return { done: true, offset };
            const object = await bucket.get(job.sourceKey, {
              onlyIf: { etagMatches: file.etag },
              ...(offset ? { range: { offset } } : {}),
            });
            if (!object || !('body' in object))
              return { done: true, offset, error: 'The uploaded file changed during the import.' };
            const r = await readBulkChunk(
              csvRecords(object.body, offset),
              job.kind,
              job,
              BULK_CHUNK_ROWS,
            );
            if (!r.ok) return { done: true, offset, error: r.error.slice(0, 512) };
            if (r.nextRow - 2 > BULK_MAX_ROWS)
              return {
                done: true,
                offset,
                error: 'The file exceeds the 100,000 row import limit.',
              };
            const result = await applyBulkRows(
              {
                companies: companyDirectory(this.env),
                books: priceBookStore(this.env),
                inventory: inventoryStore(this.env),
                pricing: pricingStore(this.env),
              },
              job,
              r.rows,
              Date.now(),
            );
            const errors = result.errors.map(({ row, error }) => ({
              row,
              error: error.slice(0, 512),
            }));
            const key = parts + partName(offset);
            if (errors.length)
              await bucket.put(key, errors.map((e) => csvLine([e.row, e.error])).join(''));
            else await bucket.delete(key); // A retried chunk may have a different row outcome.
            await jobs.advance(
              id,
              offset,
              { offset: r.offset, nextRow: r.nextRow, header: r.header, ...result, errors },
              Date.now(),
            );
            return { done: r.done || r.offset === file.size, offset: r.offset };
          },
        );
        offset = chunk.offset;
        if (chunk.done) {
          error = chunk.error ?? null;
          break;
        }
      }
      const report = await step.do('check report', async () => {
        const job = await jobs.get(id);
        return job?.status === 'running' && job.failed > 0;
      });
      let reportKey: string | null = null;
      if (report) {
        // Group the fragments so even a maximum-size job fits the subrequest limit of each step.
        const groups: File[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page: { group: File; next?: string } = await step.do(
            `report group ${groups.length}`,
            async () => {
              const page = await bucket.list({ prefix: parts, limit: 100, cursor });
              const group = await joinFiles(
                bucket,
                `${prefix}group-${groups.length}`,
                page.objects,
              );
              return { group, next: page.truncated ? page.cursor : undefined };
            },
          );
          groups.push(page.group);
          cursor = page.next;
          if (!cursor) break;
        }
        reportKey = `imports/${id}/report.csv`;
        const key = reportKey;
        await step.do('write report', () =>
          joinFiles(bucket, key, groups, csvLine(['row', 'error'])),
        );
      }
      await step.do('finish', () =>
        jobs.finish(id, error ? 'failed' : 'done', Date.now(), { error, reportKey }),
      );
    } catch (err) {
      await step.do('record failure', () =>
        jobs.finish(id, 'failed', Date.now(), { error: 'The import could not be completed.' }),
      );
      throw err;
    } finally {
      for (let n = 0; ; n++) {
        const more = await step.do(`clean up ${n}`, async () => {
          const page = await bucket.list({ prefix });
          if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
          return page.truncated;
        });
        if (!more) break;
      }
    }
  }
}
