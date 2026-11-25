/**
 * Bulk import jobs: a CSV an admin uploaded, read and applied a chunk at a time by the engine's
 * import Workflow. The job row is the import's progress and its record: where reading stopped,
 * how many rows were applied and refused, and the first refusals (`BULK_KEPT_ERRORS`).
 */
import type { BulkKind } from '@commerceworker/core';

export type BulkJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** A row an import refused: its line in the file (the header is row 1) and why. */
export interface BulkRowError {
  readonly row: number;
  readonly error: string;
}

export interface BulkJob {
  readonly id: string;
  readonly kind: BulkKind;
  /** Checks every row and writes nothing. */
  readonly checkOnly: boolean;
  readonly fileName: string;
  /** Where the uploaded file is kept (the documents bucket). */
  readonly sourceKey: string;
  /** Where the refused rows are written as CSV once it ends; null until then, or with none. */
  readonly reportKey: string | null;
  readonly status: BulkJobStatus;
  /** The file's header row, read with the first chunk; empty before. */
  readonly header: readonly string[];
  /** The byte offset reading continues from, and the next row's number. */
  readonly offset: number;
  readonly nextRow: number;
  readonly applied: number;
  readonly failed: number;
  /** The first refusals, by row. */
  readonly errors: readonly BulkRowError[];
  /** Why the whole job stopped, when it failed. */
  readonly error: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type NewBulkJob = Pick<
  BulkJob,
  'id' | 'kind' | 'checkOnly' | 'fileName' | 'sourceKey' | 'createdBy' | 'createdAt'
>;

/** One chunk's progress: where reading got to, and what its rows did. */
export interface BulkChunk {
  /** The header row, when this chunk read it (the first). */
  readonly header?: readonly string[];
  readonly offset: number;
  readonly nextRow: number;
  readonly applied: number;
  readonly failed: number;
  readonly errors: readonly BulkRowError[];
}

export interface BulkJobStore {
  /** Records a new job, `queued`. */
  create(job: NewBulkJob): Promise<void>;
  get(id: string): Promise<BulkJob | undefined>;
  /** The latest jobs, newest first. */
  list(limit: number): Promise<BulkJob[]>;
  /** `queued` to `running`; false when it wasn't queued (a retry, or cancelled first). */
  start(id: string, at: number): Promise<boolean>;
  /**
   * Adds a chunk's progress, only while the job is `running` and still at `from` (the offset the
   * chunk began at), so a step retried after it was recorded adds nothing twice. Errors are kept
   * up to `BULK_KEPT_ERRORS`, by row. False when nothing was recorded.
   */
  advance(id: string, from: number, chunk: BulkChunk, at: number): Promise<boolean>;
  /** Ends a `queued` or `running` job; false when it had already ended. */
  finish(
    id: string,
    status: 'done' | 'failed' | 'cancelled',
    at: number,
    end?: { reportKey?: string | null; error?: string | null },
  ): Promise<boolean>;
}
