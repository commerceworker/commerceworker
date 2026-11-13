/**
 * The engine's Durable Objects: a nightly copy of live order and cart state, a restore to a point
 * in time, and a drill that proves the restore. Three Workflows, bound only when the registry's
 * `redundancy` is on and `objectBackup` is not an exception (apps/engine/wrangler.jsonc, rendered
 * per deployment by scripts/fleet.ts).
 *
 * ObjectsBackup lists the live orders and carts from D1 and writes each one's exported state into
 * the backups bucket (`objects/<date>/`), a page a step and the manifest last, as D1Backup does
 * (d1-backup.ts). ObjectsRestore is for an operator only: nothing schedules it, and it is started
 * with `wrangler workflows trigger` (docs/operations.md, "Restoring an order's or cart's live
 * state"). ObjectsDrill rewinds a probe object, checks it, and undoes the rewind, on the D1
 * drill's cadence. The logic is `@commerceworker/application`'s `objects-restore.ts`; this file is
 * the durability around it.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  checkProbe,
  findBookmarks,
  type ObjectsDrillEvidence,
  type ObjectsRestorePlan,
  objectsDrillKey,
  parseObjectsRestore,
  type RestoreOutcome,
  type RestoreReport,
  reindexObject,
  restoreObject,
  SNAPSHOT_CAP,
  type SnapshotChunk,
  type SnapshotManifest,
  type SnapshotStep,
  snapshotChunk,
  snapshotDate,
  snapshotManifestKey,
  writeRestoreReport,
  writeSnapshotManifest,
} from '@commerceworker/application/commerce';
import {
  BackupRefusal,
  SNAPSHOT_CLASSES,
  type SnapshotClass,
} from '@commerceworker/ports/commerce';
import { activeObjects, drillObject, objectState } from './wire';

const COPY = { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } } as const;
// A rewind that didn't take is tried again a few times, then recorded against its object.
const RESTORE = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } } as const;
// A step that changes nothing and fails only on what was asked for: failed at once, with its reason.
const ONCE = { retries: { limit: 0, delay: '1 second' } } as const;

/** A refusal ends the step at once: retrying a time out of reach finds it the same. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof BackupRefusal) throw new NonRetryableError(err.message, 'BackupRefusal');
    throw err;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class ObjectsBackup extends WorkflowEntrypoint<Env, Record<string, never>> {
  override async run(event: Readonly<WorkflowEvent<Record<string, never>>>, step: WorkflowStep) {
    const date = snapshotDate(event.timestamp);
    const store = this.env.BACKUPS;
    const active = activeObjects(this.env);
    const state = objectState(this.env);
    // A second run on the same day (a manual one beside the schedule) finds it done.
    const done = await step.do(
      'check',
      async () => !!(await store.head(snapshotManifestKey(date))),
    );
    if (done) return { date, skipped: true };
    const startedAt = await step.do('start', async () => new Date().toISOString());

    const classes = {} as SnapshotManifest['classes'];
    for (const cls of SNAPSHOT_CLASSES) {
      const copy: SnapshotManifest['classes'][SnapshotClass] = {
        objects: 0,
        errors: 0,
        capped: false,
        chunks: [],
      };
      let after = '';
      for (let n = 0; ; n++) {
        const left = SNAPSHOT_CAP - copy.objects;
        if (left <= 0) {
          // Whatever remains is left for the next night's order; say so.
          copy.capped = true;
          break;
        }
        const got: SnapshotStep = await step.do(`chunk ${cls}#${n}`, COPY, () =>
          snapshotChunk(active, state, store, { date, class: cls, n, after, take: left }),
        );
        if (got.chunk) {
          copy.chunks.push(got.chunk satisfies SnapshotChunk);
          copy.objects += got.chunk.objects;
          copy.errors += got.chunk.errors;
        }
        after = got.next;
        if (!got.more) break;
      }
      classes[cls] = copy;
    }

    return await step.do('manifest', COPY, async () => {
      await writeSnapshotManifest(store, {
        format: 1,
        date,
        startedAt,
        finishedAt: new Date().toISOString(),
        classes,
      });
      return {
        date,
        orders: classes.OrderAgent.objects,
        carts: classes.CartAgent.objects,
        errors: classes.OrderAgent.errors + classes.CartAgent.errors,
      };
    });
  }
}

export class ObjectsRestore extends WorkflowEntrypoint<Env, unknown> {
  override async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep) {
    const store = this.env.BACKUPS;
    const state = objectState(this.env);
    // What was asked for is checked before anything is touched; a refusal fails the instance with it.
    const plan: ObjectsRestorePlan = parseObjectsRestore(event.payload, event.timestamp.getTime());
    const startedAt = event.timestamp.toISOString();

    // Every bookmark first: a time out of reach for any one object changes nothing.
    const bookmarks = await step.do('bookmarks', ONCE, () =>
      refusing(() => findBookmarks(state, plan)),
    );

    const objects: RestoreOutcome[] = [];
    for (const name of plan.names) {
      const bookmark = bookmarks[name] as string;
      const outcome: RestoreOutcome = { name, bookmark, undo: null, reindexed: false };
      try {
        outcome.undo =
          (await step.do(`restore ${name}`, RESTORE, () =>
            restoreObject(state, store, {
              class: plan.class,
              name,
              bookmark,
              instance: event.instanceId,
            }),
          )) || null;
        // The object restarted restored: what D1 indexes of it is brought back in step. A cart's
        // or an order's row follows the object, so a restore never leaves the lists stale.
        outcome.reindexed = await step.do(`reindex ${name}`, RESTORE, () =>
          reindexObject(state, plan.class, name),
        );
      } catch (err) {
        outcome.error = message(err);
      }
      objects.push(outcome);
    }

    const failed = objects.filter((o) => o.error);
    const report = await step.do('report', COPY, async () => {
      const r: RestoreReport = {
        instance: event.instanceId,
        startedAt,
        finishedAt: new Date().toISOString(),
        class: plan.class,
        mode: plan.mode,
        ...(plan.mode === 'at' ? { at: new Date(plan.at).toISOString() } : {}),
        outcome: failed.length ? 'failed' : 'restored',
        objects,
        undo: Object.fromEntries(objects.filter((o) => o.undo).map((o) => [o.name, o.undo!])),
      };
      await writeRestoreReport(store, r);
      if (failed.length) console.error('objects restore failed', JSON.stringify(r));
      return r;
    });
    // The instance fails with it, so the Workflows dashboard shows it; the report still has every undo.
    if (failed.length)
      throw new NonRetryableError(
        `${failed.length} of ${objects.length} objects did not restore (${failed.map((o) => o.name).join(', ')}): the report has each one's undo`,
        'RestoreFailed',
      );
    return report;
  }
}

export class ObjectsDrill extends WorkflowEntrypoint<Env, Record<string, never>> {
  override async run(event: Readonly<WorkflowEvent<Record<string, never>>>, step: WorkflowStep) {
    const store = this.env.BACKUPS;
    const probe = drillObject(this.env);
    const date = snapshotDate(event.timestamp);
    const started = await step.do('start', async () => Date.now());
    const ev: ObjectsDrillEvidence = {
      outcome: 'passed',
      date,
      instance: event.instanceId,
      startedAt: new Date(started).toISOString(),
      finishedAt: '',
      minutes: 0,
      bookmark: null,
      undo: null,
      checks: { restored: null, undone: null },
    };
    let failure: string | undefined;

    try {
      // One row, a bookmark, a second row; the rewind must drop the second, and its undo bring it back.
      await step.do('reset', COPY, async () => probe.reset());
      ev.bookmark = await step.do('mark before', COPY, () => probe.mark('before'));
      await step.do('mark after', COPY, () => probe.mark('after'));
      const bookmark = ev.bookmark;
      ev.undo =
        (await step.do('restore', RESTORE, () =>
          restoreObject(probe, store, {
            class: 'HealthProbe',
            name: 'drill',
            bookmark,
            instance: event.instanceId,
          }),
        )) || null;
      ev.checks.restored = await step.do('check restored', COPY, () =>
        checkProbe(probe, ['before']),
      );
      const undo = ev.undo;
      if (!undo) throw new Error('the restore kept no undo bookmark');
      await step.do('undo', RESTORE, () =>
        restoreObject(probe, store, {
          class: 'HealthProbe',
          name: 'drill',
          bookmark: undo,
          instance: `${event.instanceId}-undo`,
        }),
      );
      ev.checks.undone = await step.do('check undone', COPY, () =>
        checkProbe(probe, ['after', 'before']),
      );
      if (!ev.checks.restored.ok || !ev.checks.undone.ok)
        failure = 'the probe did not hold the rows a restore and its undo should leave';
    } catch (err) {
      failure = message(err);
    }

    const evidence = await step.do('evidence', COPY, async () => {
      const now = Date.now();
      const e: ObjectsDrillEvidence = {
        ...ev,
        outcome: failure ? 'failed' : 'passed',
        finishedAt: new Date(now).toISOString(),
        minutes: Math.round(((now - started) / 60_000) * 10) / 10,
        ...(failure ? { error: failure } : {}),
      };
      // Not under a lock, so a second drill the same day replaces the first.
      await store.put(objectsDrillKey(date), JSON.stringify(e, null, 2));
      if (failure) console.error('objects restore drill failed', JSON.stringify(e));
      return e;
    });
    if (failure) throw new NonRetryableError(failure, 'DrillFailed');
    return evidence;
  }
}
