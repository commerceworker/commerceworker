/**
 * The commerce database's backup and restore drill, two Workflows created by their bindings' cron
 * schedules (apps/engine/wrangler.jsonc, rendered per deployment from the registry's `redundancy`).
 *
 * D1Backup copies every table of record into the backups bucket (`d1/<date>/`), one step a chunk
 * and the manifest last, as the catalog's backup does (apps/catalog/src/backup.ts). D1Restore
 * rebuilds the newest backup, or the `date` it is given, in `STANDBY_DB` and checks the result;
 * it has no other target, and the standby holds nothing a deploy needs. What a restore did, and
 * what failed, is `drills/<date>.json`. The logic is `@commerceworker/application`'s
 * `database-backup.ts`; this file is the durability around it.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  BACKUP_FORMAT,
  type BackupManifest,
  backupDate,
  type ChunkCopy,
  checkRestore,
  checksPassed,
  copyChunk,
  type DrillEvidence,
  drillKey,
  latestBackupDate,
  loadChunk,
  manifestKey,
  readManifest,
  type TableCopy,
  verifyTable,
  writeManifest,
} from '@commerceworker/application/commerce';
import { BackupRefusal } from '@commerceworker/ports/commerce';
import { databaseExport, restoreTarget, standbyAudit } from './wire';

const COPY = { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } } as const;

/** A refusal ends the step at once: retrying a missing or altered chunk finds it the same. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof BackupRefusal) throw new NonRetryableError(err.message, 'BackupRefusal');
    throw err;
  }
}

export class D1Backup extends WorkflowEntrypoint<Env, Record<string, never>> {
  override async run(event: Readonly<WorkflowEvent<Record<string, never>>>, step: WorkflowStep) {
    const date = backupDate(event.timestamp);
    const store = this.env.BACKUPS;
    const source = databaseExport(this.env);
    // A second run on the same day (a manual one beside the schedule) finds it done.
    const done = await step.do('check', async () => !!(await store.head(manifestKey(date))));
    if (done) return { date, skipped: true };

    const plan = await step.do('schema', COPY, async () => ({
      startedAt: new Date().toISOString(),
      schema: await source.schema(),
      migrationHead: await source.migrationHead(),
    }));

    const tables: Record<string, TableCopy> = {};
    for (const table of plan.schema.tables) {
      const copy: TableCopy = { rows: 0, chunks: [] };
      let cursor = 0;
      for (let n = 0; ; n++) {
        const got: ChunkCopy = await step.do(`chunk ${table.name}#${n}`, COPY, () =>
          refusing(() => copyChunk(source, store, { date, table: table.name, n, cursor })),
        );
        if (got.chunk) {
          copy.chunks.push(got.chunk);
          copy.rows += got.chunk.rows;
        }
        cursor = got.next;
        if (!got.more) break;
      }
      tables[table.name] = copy;
    }

    return await step.do('manifest', COPY, async () => {
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        date,
        startedAt: plan.startedAt,
        finishedAt: new Date().toISOString(),
        migrationHead: plan.migrationHead,
        timeTravelBookmark: null,
        schema: plan.schema,
        tables,
      };
      await writeManifest(store, manifest);
      return {
        date,
        tables: plan.schema.tables.length,
        rows: Object.values(tables).reduce((sum, t) => sum + t.rows, 0),
      };
    });
  }
}

export type RestoreParams = {
  /** The backup to restore (`yyyy-mm-dd`); the newest finished one when unset. */
  date?: string;
};

export class D1Restore extends WorkflowEntrypoint<Env, RestoreParams> {
  override async run(event: Readonly<WorkflowEvent<RestoreParams>>, step: WorkflowStep) {
    const store = this.env.BACKUPS;
    const target = restoreTarget(this.env);
    const ran = backupDate(event.timestamp);
    const started = await step.do('start', async () => Date.now());
    let backup: string | null = null;
    let checks: DrillEvidence['checks'] = null;
    let failure: string | undefined;

    try {
      // Steps pass on the date and the table list, not the manifest: it grows with the database,
      // and a step's result is capped.
      const found = await step.do('find backup', COPY, () =>
        refusing(async () => {
          const date = event.payload?.date ?? (await latestBackupDate(store));
          if (!date) throw new BackupRefusal('no finished backup to restore');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BackupRefusal(`${date} is not a date`);
          const manifest = await readManifest(store, date);
          if (!manifest)
            throw new BackupRefusal(`${date} has no manifest: that backup did not finish`);
          return {
            date,
            tables: manifest.schema.tables.map((t) => ({
              name: t.name,
              chunks: manifest.tables[t.name]?.chunks.length ?? 0,
            })),
          };
        }),
      );
      backup = found.date;
      const manifest = () => readManifest(store, found.date).then((m) => m!);

      // Every chunk is checked before anything is wiped: a tampered backup changes nothing.
      for (const table of found.tables)
        await step.do(`verify ${table.name}`, COPY, () =>
          refusing(async () => verifyTable(store, await manifest(), table.name)),
        );

      await step.do('reset standby', COPY, () => refusing(() => target.reset()));
      await step.do('create tables', COPY, async () =>
        target.createTables((await manifest()).schema),
      );
      for (const table of found.tables)
        for (let n = 0; n < table.chunks; n++)
          await step.do(`load ${table.name}#${n}`, COPY, () =>
            refusing(async () => loadChunk(store, target, await manifest(), table.name, n)),
          );
      await step.do('indexes and search', COPY, async () =>
        target.finish((await manifest()).schema),
      );

      checks = await step.do('check', COPY, async () =>
        checkRestore(await manifest(), target, standbyAudit(this.env)),
      );
      if (!checksPassed(checks)) failure = 'a check of the restored database failed';
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    const evidence = await step.do('evidence', COPY, async () => {
      const now = Date.now();
      const e: DrillEvidence = {
        outcome: failure ? 'failed' : 'passed',
        date: ran,
        backup,
        instance: event.instanceId,
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date(now).toISOString(),
        minutes: Math.round(((now - started) / 60_000) * 10) / 10,
        checks,
        ...(failure ? { error: failure } : {}),
      };
      // Not under a lock, so a second drill the same day replaces the first.
      await store.put(drillKey(ran), JSON.stringify(e, null, 2));
      if (failure) console.error('d1 restore drill failed', JSON.stringify(e));
      return e;
    });
    // The instance fails with it, so the Workflows dashboard shows it too.
    if (failure) throw new NonRetryableError(failure, 'DrillFailed');
    return evidence;
  }
}
