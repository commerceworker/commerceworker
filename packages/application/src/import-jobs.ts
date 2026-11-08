import { type Principal, type Scope, ValidationError } from '@commerceworker/domain';
import type {
  BlobStore,
  BulkJob,
  BulkJobChunk,
  ImportSource,
  RemoteFetcher,
} from '@commerceworker/ports';
import { actingForJob, persistJob } from './bulk-jobs';
import type { AppContext } from './context';
import { createEntry } from './entries';
import {
  IMPORT_JOB_CHUNK_SIZE,
  IMPORT_JOB_MAX_RECORDS,
  type ImportAnalysis,
  type ImportInput,
  type ImportRunOptions,
  type PlannedRecord,
  planImport,
  updateImportedEntry,
} from './import';
import { importChunkKey } from './job-staging';
import { isSnapshotJob, runSnapshotChunk } from './snapshot-jobs';

/**
 * Importing more than one request can hold.
 *
 * The synchronous path writes everything before it answers, which stops being
 * reasonable somewhere around ten thousand records — a request that takes four
 * minutes is a request that times out. This runs the same import as a durable
 * job: the same planner, the same use-cases, chunked so it survives a crash,
 * a deploy, and a client that hung up.
 *
 * It reuses the bulk-job machinery rather than growing its own, which is what
 * buys resumability, cancellation, the stall sweep and a per-item report
 * without writing any of them twice.
 */

/**
 * What each chunk gets handed.
 *
 * Records are staged **once, at plan time**, not re-derived per chunk. Every
 * chunk re-reading and re-parsing the source file would make a forty-thousand
 * row import quadratic — and worse, would let two chunks disagree about what
 * the file said if it were fetched from anywhere that can change.
 */
interface StagedChunk {
  readonly records: readonly PlannedRecord[];
  /** Fields the job's principal may not write: names only, kept by updates as they run. */
  readonly blockedFields?: readonly string[];
}

export interface ImportJobConfig extends Record<string, unknown> {
  readonly contentTypeApiId: string;
  readonly locale: string;
}

export interface StartImportJobResult {
  readonly job: BulkJob;
  readonly analysis: ImportAnalysis;
}

export { importChunkKey } from './job-staging';

/**
 * Plans an import and starts it as a durable job.
 *
 * Planning still happens in one pass, because a report that only describes
 * part of a file is worse than no report. What gets chunked is the writing.
 *
 * The `principal` is authorized here, once, exactly as the synchronous run is (`planImport`):
 * the chunks run later in the engine with no one behind them, so only the records the principal
 * may write are ever staged. As with a scheduled action, narrowing the role afterwards doesn't
 * stop a job already started; cancel it.
 */
export async function startImportJob(
  ctx: AppContext,
  blob: BlobStore,
  principal: Principal,
  scope: Scope,
  source: ImportSource,
  input: ImportInput,
  options: ImportRunOptions = {},
): Promise<StartImportJobResult> {
  const { analysis, planned, contentType, blockedFields } = await planImport(
    ctx,
    principal,
    scope,
    source,
    input,
    options,
    IMPORT_JOB_MAX_RECORDS,
  );
  if (!analysis.executable) {
    throw new ValidationError([
      {
        field: 'mapping',
        message: analysis.missingRequiredFields.length
          ? `Required field(s) with no source: ${analysis.missingRequiredFields.join(', ')}`
          : `Target field(s) not defined on "${contentType.apiId}": ${analysis.unknownTargetFields.join(', ')}`,
      },
    ]);
  }

  // Records that cannot be written are dropped here rather than staged and
  // skipped later: the report already counted them, and staging work a chunk
  // will only refuse wastes storage and makes progress read as slower than it is.
  const writable = planned.filter((p) => p.issues.length === 0 && p.action !== 'skip');
  if (writable.length === 0) {
    throw new ValidationError([
      { field: 'payload', message: 'Nothing in this file would be imported' },
    ]);
  }

  const jobId = ctx.ids.newId();
  const now = ctx.clock.now().toISOString();
  const chunks: BulkJobChunk[] = [];

  for (let at = 0; at < writable.length; at += IMPORT_JOB_CHUNK_SIZE) {
    // Zero-padded ordinal, matching the publish path: sorts lexically in
    // report order.
    const chunkId = `c${String(chunks.length).padStart(5, '0')}`;
    const payloadKey = importChunkKey(scope, jobId, chunkId);
    const staged: StagedChunk = {
      records: writable.slice(at, at + IMPORT_JOB_CHUNK_SIZE),
      ...(blockedFields.length ? { blockedFields } : {}),
    };
    // Staged before the job exists, so a chunk can never be claimed before the
    // work it refers to is readable.
    await blob.put(payloadKey, JSON.stringify(staged), 'application/json');
    chunks.push({
      jobId,
      chunkId,
      entryIds: [],
      payloadKey,
      status: 'pending',
      attempts: 0,
      failures: [],
    });
  }

  const config: ImportJobConfig = {
    contentTypeApiId: contentType.apiId,
    locale: analysis.locale,
  };
  const job = await persistJob(
    ctx,
    scope,
    {
      id: jobId,
      action: 'import',
      status: 'running',
      totalItems: writable.length,
      totalChunks: chunks.length,
      completedChunks: 0,
      succeeded: 0,
      failed: 0,
      createdAt: now,
      config,
    },
    chunks,
    now,
  );
  return { job, analysis };
}

export interface ImportChunkOutcome {
  readonly succeeded: number;
  readonly failures: readonly { id: string; error: string }[];
}

/**
 * Writes one staged chunk.
 *
 * Records go through `createEntry`/`updateEntry` like every other write, so
 * validation, uniqueness, hooks and the reference graph all apply — a job is
 * not a back door around the content model. Nor around the role that started
 * it: `startImportJob` staged only what that principal may write, and the
 * names of the fields an update must keep, so a chunk has nothing left to
 * authorize.
 *
 * Re-running is safe in the sense that matters for at-least-once delivery: a
 * re-run of an *update* chunk writes the same values again, and a re-run of a
 * *create* chunk creates duplicates only where the import declared no identity
 * field — which is the same thing running the import twice by hand would do,
 * and which the analysis warned about before the job started.
 */
export async function runImportChunk(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  contentTypeApiId: string,
  payloadKey: string,
): Promise<ImportChunkOutcome> {
  const raw = await blob.get(payloadKey);
  if (raw === null) {
    // The staged work is gone. Failing the chunk is right: silently reporting
    // success would claim records were imported that never were.
    throw new Error(`Staged records for this chunk are missing (${payloadKey})`);
  }
  const staged = JSON.parse(raw) as StagedChunk;

  let succeeded = 0;
  const failures: { id: string; error: string }[] = [];
  for (const record of staged.records) {
    try {
      // Judged as the preview judged it: on the record's values (see `EntryWriteOptions.copy`).
      if (record.action === 'update' && record.entryId) {
        await updateImportedEntry(
          ctx,
          scope,
          record.entryId,
          record.fields,
          staged.blockedFields ?? [],
        );
      } else {
        await createEntry(ctx, scope, { contentTypeApiId, fields: record.fields }, { copy: true });
      }
      succeeded += 1;
    } catch (err) {
      failures.push({
        id: record.externalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { succeeded, failures };
}

/** Removes a finished job's staged records. Best-effort: storage, not truth. */
export async function discardImportChunk(blob: BlobStore, payloadKey: string): Promise<void> {
  await blob.delete(payloadKey).catch(() => {});
}

/**
 * The chunk handler to hand `runBulkChunk`.
 *
 * Bundles the blob store a consumer already has with the work of writing and
 * then discarding a chunk's staged records, so wiring is one call rather than
 * a shape to remember. `fetcher` copies the asset files a space export import
 * brings; without it those chunks wait for a consumer that has one.
 */
export function importChunkRunner(base: AppContext, blob: BlobStore, fetcher?: RemoteFetcher) {
  return async (scope: Scope, job: BulkJob, chunk: BulkJobChunk) => {
    const ctx = actingForJob(base, job);
    if (isSnapshotJob(job.config)) {
      const outcome = await runSnapshotChunk(
        ctx,
        blob,
        scope,
        job.config,
        chunk.payloadKey,
        fetcher,
      );
      if (chunk.payloadKey) await discardImportChunk(blob, chunk.payloadKey);
      return outcome;
    }
    const config = job.config as ImportJobConfig | undefined;
    if (!chunk.payloadKey || !config?.contentTypeApiId) {
      throw new Error(`Import chunk ${job.id}/${chunk.chunkId} is missing its staged work`);
    }
    const outcome = await runImportChunk(
      ctx,
      blob,
      scope,
      config.contentTypeApiId,
      chunk.payloadKey,
    );
    // The records have been written; keeping them would leave a copy of the
    // import sitting in object storage indefinitely.
    await discardImportChunk(blob, chunk.payloadKey);
    return outcome;
  };
}
