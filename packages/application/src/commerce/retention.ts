/**
 * The daily retention sweep's steps: prune what is past its retention, purge carts that ended long
 * ago, index the buyers of carts opened before buyers were indexed, archive old audit events to R2
 * and delete them, erase the buyer from orders past the deployment's personal data retention, and
 * delete addresses last used before it. Each step is bounded, so one sweep never runs unbounded
 * work; what is left waits for the next day's. Time comes in as `now`.
 */
import { auditArchiveKey, auditCopyKey, type RetentionPolicy } from '@commerceworker/core';
import type {
  AuditArchive,
  AuditLog,
  AuditRow,
  CartRuntime,
  RetentionStore,
} from '@commerceworker/ports/commerce';

const DAY = 86_400_000;

/** Ended carts one sweep clears; the rest wait for the next day's. */
export const PURGE_MAX = 200;
/** External carts one sweep re-indexes. */
export const BACKFILL_MAX = 200;
/** Audit events per archive object, and the most one sweep moves. */
export const ARCHIVE_BATCH = 1000;
export const ARCHIVE_MAX = 50_000;
/** Orders whose buyer one sweep erases. */
export const EXPIRE_MAX = 500;

/** Deletes every prunable row past its retention, in one transaction. */
export const pruneExpired = (
  ports: { readonly retention: RetentionStore },
  now: number,
  policy: RetentionPolicy,
) => ports.retention.prune(now, policy);

/** Clears the chat, files and buyer of carts that ended past their retention. Returns how many. */
export async function purgeEndedCarts(
  ports: { readonly retention: RetentionStore; readonly carts: CartRuntime },
  now: number,
  policy: RetentionPolicy,
) {
  let purged = 0;
  for (const id of await ports.retention.endedCarts(now - policy.endedCartsMs, PURGE_MAX))
    if ((await ports.carts.purge(id)).purged) purged++;
  return purged;
}

/**
 * Records the buyer of external carts opened before carts' buyers were indexed, so a data subject
 * request finds them: each cart's agent writes its row again, and `eraseIfErased` erases someone
 * erased before this cart named them. A row whose agent holds nothing is marked as having no
 * buyer; one cart that can't answer waits for the next sweep. Returns how many were indexed.
 */
export async function indexCartBuyers(
  ports: { readonly retention: RetentionStore; readonly carts: CartRuntime },
  eraseIfErased: (cartId: string, buyerId: string) => Promise<unknown>,
) {
  let indexed = 0;
  for (const id of await ports.retention.cartsWithoutBuyer(BACKFILL_MAX)) {
    try {
      if (await ports.carts.reindex(id)) {
        indexed++;
        const buyer = await ports.retention.cartBuyer(id);
        if (buyer) await eraseIfErased(id, buyer);
      } else await ports.retention.markBuyerless(id);
    } catch (e) {
      console.error(JSON.stringify({ type: 'cart_reindex_failed', id, error: String(e) }));
    }
  }
  return indexed;
}

/**
 * Moves audit events older than `retentionDays` to the archive, one object per batch, deleting
 * each batch only once its object is written. Chained events go in chain order and stop at the
 * first one still inside the retention, so what stays is an unbroken chain; events from before the
 * chain go by time. A batch whose object is already there (a sweep that stopped before its delete)
 * is only deleted: an archive key is never written twice. A chained batch that the daily copy
 * already holds (`copiedThrough`, from `auditCopiedThrough`) is only deleted too. Returns how many
 * moved.
 */
export async function archiveAudit(
  ports: { readonly retention: RetentionStore; readonly archive: AuditArchive },
  now: number,
  retentionDays: number,
  copiedThrough = 0,
) {
  const cutoff = now - retentionDays * DAY;
  let moved = 0;
  const put = async (rows: AuditRow[]) => {
    const key = auditArchiveKey(rows[0]!, rows.length);
    if (!(await ports.archive.has(key))) await ports.archive.put(key, rows);
  };

  while (moved < ARCHIVE_MAX) {
    const rows = await ports.retention.unchainedAudit(cutoff, ARCHIVE_BATCH);
    if (!rows.length) break;
    await put(rows);
    await ports.retention.deleteUnchainedThrough(rows.at(-1)!);
    moved += rows.length;
    if (rows.length < ARCHIVE_BATCH) break;
  }

  while (moved < ARCHIVE_MAX) {
    const batch = await ports.retention.chainedAudit(ARCHIVE_BATCH);
    const old = batch.findIndex((r) => r.at >= cutoff);
    const rows = old === -1 ? batch : batch.slice(0, old);
    if (!rows.length) break;
    if (rows.at(-1)!.seq! > copiedThrough) await put(rows);
    await ports.retention.deleteChainedThrough(rows.at(-1)!.seq!);
    moved += rows.length;
    if (rows.length < batch.length || batch.length < ARCHIVE_BATCH) break;
  }
  return moved;
}

/** Daily copies `auditCopiedThrough` checks, newest first, before it gives up on finding one. */
const COPIES_CHECKED = 5;

/**
 * The last chain seq the daily copies hold that the database still agrees with: the newest copy
 * whose last event is still in the chain with the same hash. After a restore the lost events'
 * copies no longer match, so it falls back to an earlier one, and 0 when none does (the chain is
 * copied from its oldest kept event again).
 */
export async function auditCopiedThrough(ports: { audit: AuditLog; archive: AuditArchive }) {
  const copies = (await ports.archive.copies()).slice(-COPIES_CHECKED).reverse();
  for (const c of copies) {
    const link = await ports.audit.link(c.to);
    if (link?.hash.startsWith(c.hash)) return c.to;
  }
  return 0;
}

/**
 * Copies sealed audit events that no copy holds yet to the archive, one object per batch, leaving
 * them in the database: R2 then holds them long before `AUDIT_RETENTION_DAYS`, so a database
 * restore (which drops every event after its bookmark) can't lose them. A copy's key names its
 * range and last hash, so a run that stopped before the next one only writes what is missing.
 * Returns how many it copied.
 */
export async function copyAudit(ports: { audit: AuditLog; archive: AuditArchive }) {
  let through: number | undefined = (await auditCopiedThrough(ports)) || undefined;
  let copied = 0;
  while (copied < ARCHIVE_MAX) {
    const rows = await ports.audit.sealedAfter(through, ARCHIVE_BATCH);
    if (!rows.length) break;
    const key = auditCopyKey(rows[0]!.seq, rows.at(-1)!.seq, rows.at(-1)!.hash);
    if (!(await ports.archive.has(key))) await ports.archive.put(key, rows);
    through = rows.at(-1)!.seq;
    copied += rows.length;
    if (rows.length < ARCHIVE_BATCH) break;
  }
  return copied;
}

/**
 * Erases the buyer from orders that ended more than `days` ago (`erase`, the data subject
 * erasure). Orders it refuses (still running in their agent) are tried again tomorrow. Returns how
 * many were erased, and the refused ones.
 */
export async function expirePersonalData(
  ports: { readonly retention: RetentionStore },
  now: number,
  days: number,
  erase: (
    orders: { id: string; title: string }[],
  ) => Promise<{ orders: number; refused: string[] }>,
) {
  const due = await ports.retention.ordersEndedBefore(now - days * DAY, EXPIRE_MAX);
  return erase(due);
}

/** Deletes customer addresses last used more than `days` ago. Returns how many. */
export const expireAddresses = (
  ports: { readonly retention: RetentionStore },
  now: number,
  days: number,
) => ports.retention.expireAddresses(now - days * DAY);

/** Blanks the name and email of company members removed more than `days` ago. Returns how many. */
export const expireMembers = (
  ports: { readonly retention: RetentionStore },
  now: number,
  days: number,
) => ports.retention.expireMembers(now - days * DAY);
