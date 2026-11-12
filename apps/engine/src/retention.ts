/**
 * Retention: a daily sweep (the Worker's cron trigger) that deletes rows nothing reads once they
 * are old. Orders and everything that is part of an order's record (payments, shipments, the stock
 * and balance ledgers, flow versions) are kept. Audit events past the deployment's retention
 * (`AUDIT_RETENTION_DAYS`, 400 days unless set) are archived to R2 first, then deleted. Where a
 * deployment sets `PERSONAL_DATA_RETENTION_DAYS`, orders finished longer ago than that lose their
 * buyer's personal data, as an erasure request would remove it (`eraseOrders`); the commercial
 * record stays, and the customer addresses last shipped to before then are deleted. Orders started before customer
 * addresses were kept add theirs (`backfillAddresses`). Stored
 * secrets are resealed under the current `DATA_KEY` (`resealSecrets`). Hosted card payments that
 * began and never finished are settled (`settleOrphanedHolds`): the order placed if its hold is open,
 * the hold released otherwise. Expired storefront sign-ins and sessions are deleted
 * (`pruneShopperAuth`), and so are UCP identity links a month after they ended, with their codes and
 * tokens (`pruneUcpLinks`). A sandboxed plugin's uninstall export (`plugin-exports/`) is deleted once it
 * is 30 days old, or the personal data retention if that is shorter (`expirePluginExports`).
 */

import * as uc from '@commerceworker/application/commerce';
import { auditRetentionDays, personalDataRetentionDays, RETENTION } from '@commerceworker/core';
import { settleOrphanedHolds } from './checkout/hosted';
import { pruneConfirmations } from './confirmations';
import { backfillAddresses } from './customer-addresses';
import { resealSecrets } from './data-key';
import { eraseIfErased, eraseOrders } from './subjects';
import { pruneUsage } from './usage';
import { auditArchive, cartRuntime, retentionStore, shopperAuth, ucpLinks } from './wire';

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
    membersExpired: await expireMembers(env, now),
    addressesBackfilled: await backfillAddresses(env, now),
    confirmations: await pruneConfirmations(env, now),
    shopperAuth: await uc.pruneShopperAuth({ shoppers: shopperAuth(env) }, now),
    ucpLinks: await uc.pruneUcpLinks({ links: ucpLinks(env) }, now),
    aiUsageDays: await pruneUsage(env, now),
    secrets: await resealSecrets(env),
    cardHolds: await settleOrphanedHolds(env, now),
    pluginExports: await expirePluginExports(env, now),
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

/**
 * Blanks the name and email of company members removed before the deployment's personal data
 * retention (their rows stay, for the orders they placed). Returns how many.
 */
export async function expireMembers(env: Env, now = Date.now()) {
  const days = personalDataRetentionDays(env.PERSONAL_DATA_RETENTION_DAYS);
  if (days === null) return 0;
  return uc.expireMembers({ retention: retentionStore(env) }, now, days);
}

/** How long an uninstalled plugin's export stays, for an admin to download or re-import. */
export const PLUGIN_EXPORT_DAYS = 30;

/**
 * Deletes `plugin-exports/` objects past `PLUGIN_EXPORT_DAYS` (or the personal data retention, if
 * shorter): an export holds whatever the plugin stored, buyer details included. A failure is logged
 * and tried again tomorrow, and never stops the sweep's other steps. Returns how many it deleted.
 */
export async function expirePluginExports(env: Env, now = Date.now()) {
  try {
    const days = Math.min(
      PLUGIN_EXPORT_DAYS,
      personalDataRetentionDays(env.PERSONAL_DATA_RETENTION_DAYS) ?? PLUGIN_EXPORT_DAYS,
    );
    const cutoff = now - days * 86_400_000;
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const page = await env.DOCS.list({ prefix: 'plugin-exports/', cursor });
      const old = page.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
      if (old.length) await env.DOCS.delete(old);
      deleted += old.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return deleted;
  } catch (err) {
    console.error(JSON.stringify({ type: 'plugin_export_expiry_failed', error: String(err) }));
    return 0;
  }
}
