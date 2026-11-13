/**
 * The OAuth provider's nightly export: one Workflow, created by its binding's cron schedule
 * (apps/web/wrangler.jsonc, rendered per deployment from the registry's `redundancy`). `OAUTH_KV`
 * holds every client registration and grant for `/mcp`, `/a2a` and `/api/v1`, and nothing else
 * keeps a copy, so KvBackup lists it a page at a time and writes each page into the backups bucket
 * (`kv/<date>/oauth/`), a page a step and the manifest last, as the commerce database's backup does
 * (apps/engine/src/d1-backup.ts). The logic is `@commerceworker/application`'s `kv-backup.ts`; this
 * file is the durability around it. Restoring is an operator's job: docs/operations.md, "Restoring
 * OAuth grants".
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  copyKvChunk,
  KV_BACKUP_FORMAT,
  KV_MAX_CHUNKS,
  type KvChunkRecord,
  type KvChunkStep,
  type KvManifest,
  kvBackupDate,
  kvManifestKey,
  writeKvManifest,
} from '@commerceworker/application/commerce';
import type { KvExport } from '@commerceworker/ports/commerce';

/** The name of what is copied: the folder under `kv/<date>/`. */
export const OAUTH_BACKUP = 'oauth';

/**
 * Keys that are not copied: a device sign-in's state (lib/oauth-device.server.ts) lives ten minutes
 * and its record holds the caller's address, and the provider's authorization transaction and
 * replay markers are as short. A backup kept for weeks must hold neither, and a restore would only
 * bring back what has expired. `cmw_device_client:` (a registered device client) is kept: its
 * prefix ends in `_client:`, which none of these match.
 */
export const EPHEMERAL_PREFIXES = [
  'cmw_device:',
  'cmw_device_user:',
  'cmw_device_redeem:',
  'cmw_device_decision:',
  'cmw_device_attempts:',
  'cmw_device_miss:',
  'transaction:',
  'enterprise-jti:',
] as const;

const COPY = { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } } as const;

/** A KV namespace binding as the export's port: a page of keys with their expiration and metadata, and values in bulk. */
export const kvExport = (kv: KVNamespace): KvExport => ({
  async list(cursor, limit) {
    const page = await kv.list({ cursor, limit });
    return {
      keys: page.keys.map((k) => ({
        name: k.name,
        expiration: k.expiration,
        metadata: k.metadata,
      })),
      cursor: page.list_complete ? undefined : page.cursor,
    };
  },
  read: (names) => kv.get([...names]),
});

export class KvBackup extends WorkflowEntrypoint<Env, Record<string, never>> {
  override async run(event: Readonly<WorkflowEvent<Record<string, never>>>, step: WorkflowStep) {
    const date = kvBackupDate(event.timestamp);
    const store = this.env.BACKUPS;
    const source = kvExport(this.env.OAUTH_KV);
    // A second run on the same day (a manual one beside the schedule) finds it done.
    const done = await step.do(
      'check',
      async () => !!(await store.head(kvManifestKey(date, OAUTH_BACKUP))),
    );
    if (done) return { date, skipped: true };
    const startedAt = await step.do('start', async () => new Date().toISOString());

    const chunks: KvChunkRecord[] = [];
    const skipped = { ephemeral: 0, vanished: 0 };
    let cursor: string | null = null;
    let capped = false;
    for (let n = 0; ; n++) {
      if (n >= KV_MAX_CHUNKS) {
        // More than one night's copy covers: say so rather than run out of steps.
        capped = true;
        break;
      }
      const at = cursor;
      const got: KvChunkStep = await step.do(`chunk ${n}`, COPY, () =>
        copyKvChunk(source, store, { date, name: OAUTH_BACKUP, n, cursor: at }, EPHEMERAL_PREFIXES),
      );
      if (got.chunk) chunks.push(got.chunk);
      skipped.ephemeral += got.ephemeral;
      skipped.vanished += got.vanished;
      cursor = got.next;
      if (!got.more) break;
    }

    return await step.do('manifest', COPY, async () => {
      const manifest: KvManifest = {
        format: KV_BACKUP_FORMAT,
        date,
        name: OAUTH_BACKUP,
        startedAt,
        finishedAt: new Date().toISOString(),
        keys: chunks.reduce((sum, c) => sum + c.keys, 0),
        skipped,
        capped,
        chunks,
      };
      await writeKvManifest(store, manifest);
      if (capped)
        console.error('kv backup capped', JSON.stringify({ date, chunks: chunks.length }));
      return { date, keys: manifest.keys, chunks: chunks.length, skipped, capped };
    });
  }
}
