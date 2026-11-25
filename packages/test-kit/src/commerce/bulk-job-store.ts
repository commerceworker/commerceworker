/**
 * The bulk import jobs port in memory. ./bulk-job-store-contract.ts holds it to the same
 * behaviour as the D1 store.
 */
import { BULK_KEPT_ERRORS } from '@commerceworker/core';
import type { BulkJob, BulkJobStore } from '@commerceworker/ports/commerce';

export class InMemoryBulkJobStore implements BulkJobStore {
  private readonly jobs = new Map<string, BulkJob>();

  async create(job: Parameters<BulkJobStore['create']>[0]) {
    if (this.jobs.has(job.id)) throw new Error(`job ${job.id} exists`);
    this.jobs.set(job.id, {
      ...job,
      reportKey: null,
      status: 'queued',
      header: [],
      offset: 0,
      nextRow: 1,
      applied: 0,
      failed: 0,
      errors: [],
      error: null,
      updatedAt: job.createdAt,
    });
  }

  async get(id: string) {
    return this.jobs.get(id);
  }

  async list(limit: number) {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async start(id: string, at: number) {
    const j = this.jobs.get(id);
    if (j?.status !== 'queued') return false;
    this.jobs.set(id, { ...j, status: 'running', updatedAt: at });
    return true;
  }

  async advance(
    id: string,
    from: number,
    chunk: Parameters<BulkJobStore['advance']>[2],
    at: number,
  ) {
    const j = this.jobs.get(id);
    if (j?.status !== 'running' || j.offset !== from) return false;
    this.jobs.set(id, {
      ...j,
      header: chunk.header ?? j.header,
      offset: chunk.offset,
      nextRow: chunk.nextRow,
      applied: j.applied + chunk.applied,
      failed: j.failed + chunk.failed,
      errors: [...j.errors, ...chunk.errors]
        .sort((a, b) => a.row - b.row)
        .slice(0, BULK_KEPT_ERRORS),
      updatedAt: at,
    });
    return true;
  }

  async finish(
    id: string,
    status: 'done' | 'failed' | 'cancelled',
    at: number,
    end: { reportKey?: string | null; error?: string | null } = {},
  ) {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'queued' && j.status !== 'running')) return false;
    this.jobs.set(id, {
      ...j,
      status,
      updatedAt: at,
      ...(end.reportKey !== undefined ? { reportKey: end.reportKey } : {}),
      ...(end.error !== undefined ? { error: end.error } : {}),
    });
    return true;
  }
}
