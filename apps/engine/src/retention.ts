/**
 * Retention: a daily sweep (the Worker's cron trigger) that deletes rows nothing reads once they
 * are old. Orders and everything that is part of an order's record (payments, shipments, the stock
 * and balance ledgers, flow versions) are kept. Audit events past the deployment's retention
 * (`AUDIT_RETENTION_DAYS`, 400 days unless set) are archived to R2 first, then deleted. Where a
 * deployment sets `PERSONAL_DATA_RETENTION_DAYS`, orders finished longer ago than that lose their
 * buyer's personal data, as an erasure request would remove it (`eraseOrders`); the commercial
 * record stays, and the customer addresses last shipped to before then are deleted. Orders started before customer
 * addresses were kept add theirs (`backfillAddresses`). Stored
 * secrets are resealed under the current `DATA_KEY` (`resealSecrets`).
 */

import * as uc from '@commerceworker/application/commerce';
import { auditRetentionDays, personalDataRetentionDays, RETENTION } from '@commerceworker/core';
import { pruneConfirmations } from './confirmations';
import { backfillAddresses } from './customer-addresses';
import { resealSecrets } from './data-key';
import { eraseIfErased, eraseOrders } from './subjects';
import { pruneUsage } from './usage';
import { auditArchive, cartRuntime, retentionStore } from './wire';

// The policy and the archive's keys are core rules, kept importable from here.
export { auditArchiveKey, RETENTION } from '@commerceworker/core';

/** Deletes everything past its retention, then runs each bounded step. Returns what each did. */
export async function sweep(env: Env, now = Date.now()) {
  const pruned = await uc.pruneExpired({ retention: retentionStore(env) }, now, RETENTION);
  return {
    auditArchived: await archiveAudit(env, now),
    cartsPurged: await purgeEndedCarts(env, now),
    cartBuyersIndexed: await indexCartBuyers(env),
    personalDataErased: await expirePersonalData(env, now),
    addressesExpired: await expireAddresses(env, now),
    addressesBackfilled: await backfillAddresses(env, now),
    confirmations: await pruneConfirmations(env, now),
    aiUsageDays: await pruneUsage(env, now),
    secrets: await resealSecrets(env),
    ...pruned,
  };
}

/** Clears the chat, files and buyer of carts that ended past their retention. Returns how many. */
export const purgeEndedCarts = (env: Env, now = Date.now()) =>
  uc.purgeEndedCarts({ retention: retentionStore(env), carts: cartRuntime(env) }, now, RETENTION);

/**
 * Records the buyer of external carts opened before `carts.buyer_id` existed (migration 0050), so
 * a data subject request finds them. Once every row has been indexed this finds nothing.
 */
export const indexCartBuyers = (env: Env) =>
  uc.indexCartBuyers({ retention: retentionStore(env), carts: cartRuntime(env) }, (id, buyer) =>
    eraseIfErased(env, id, buyer),
  );

/** Moves audit events past `AUDIT_RETENTION_DAYS` to R2, then deletes them. Returns how many. */
export const archiveAudit = (env: Env, now = Date.now()) =>
  uc.archiveAudit(
    { retention: retentionStore(env), archive: auditArchive(env) },
    now,
    auditRetentionDays(env.AUDIT_RETENTION_DAYS),
  );

/** Erases the buyer from orders finished before the deployment's retention. Returns how many. */
export async function expirePersonalData(env: Env, now = Date.now()) {
  const days = personalDataRetentionDays(env.PERSONAL_DATA_RETENTION_DAYS);
  if (days === null) return 0;
  const r = await uc.expirePersonalData({ retention: retentionStore(env) }, now, days, (due) =>
    eraseOrders(env, due, []),
  );
  // Terminal in the index but running in its agent: skipped, and tried again tomorrow.
  if (r.refused.length)
    console.warn(JSON.stringify({ type: 'personal_data_retention_skipped', orders: r.refused }));
  return r.orders;
}

/**
 * Deletes the customer addresses last shipped to before the deployment's personal data retention:
 * the orders that used them have lost their ship-to by then. Returns how many.
 */
export async function expireAddresses(env: Env, now = Date.now()) {
  const days = personalDataRetentionDays(env.PERSONAL_DATA_RETENTION_DAYS);
  if (days === null) return 0;
  return uc.expireAddresses({ retention: retentionStore(env) }, now, days);
}
