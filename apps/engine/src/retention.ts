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
 * is 30 days old, or the personal data retention if that is shorter (`expirePluginExports`), and a
 * channel intake body (`intake/`, raw Shopify and EDI) once it is 7 days old, or that retention if
 * shorter (`expireIntake`). Every step runs on its own: one that throws is logged and reported, and
 * never skips the others.
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

/**
 * Deletes everything past its retention, then runs each bounded step. Every step is its own
 * attempt: one that throws is logged with its name and reported as `null` (and its name in
 * `failed`), and the rest still run, so a step failing every day can't stop erasure, reseal or
 * holds. Returns what each did.
 */
export async function sweep(env: Env, now = Date.now()) {
  const failed: string[] = [];
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (err) {
      console.error(
        JSON.stringify({ type: 'retention_step_failed', step: name, error: String(err) }),
      );
      failed.push(name);
      return null;
    }
  };
  const pruned = await step('pruned', () =>
    uc.pruneExpired({ retention: retentionStore(env) }, now, RETENTION),
  );
  const result = {
    auditArchived: await step('auditArchived', () => archiveAudit(env, now)),
    cartsPurged: await step('cartsPurged', () => purgeEndedCarts(env, now)),
    cartBuyersIndexed: await step('cartBuyersIndexed', () => indexCartBuyers(env)),
    personalDataErased: await step('personalDataErased', () => expirePersonalData(env, now)),
    addressesExpired: await step('addressesExpired', () => expireAddresses(env, now)),
    membersExpired: await step('membersExpired', () => expireMembers(env, now)),
    addressesBackfilled: await step('addressesBackfilled', () => backfillAddresses(env, now)),
    confirmations: await step('confirmations', () => pruneConfirmations(env, now)),
    shopperAuth: await step('shopperAuth', () =>
      uc.pruneShopperAuth({ shoppers: shopperAuth(env) }, now),
    ),
    ucpLinks: await step('ucpLinks', () => uc.pruneUcpLinks({ links: ucpLinks(env) }, now)),
    aiUsageDays: await step('aiUsageDays', () => pruneUsage(env, now)),
    secrets: await step('secrets', () => resealSecrets(env)),
    cardHolds: await step('cardHolds', () => settleOrphanedHolds(env, now)),
    pluginExports: await step('pluginExports', () => expirePluginExports(env, now)),
    intakeBodies: await step('intakeBodies', () => expireIntake(env, now)),
  };
  return { ...result, ...pruned, failed };
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

/**
 * How long a raw channel intake body stays. The queue's retries end within the hour and its retention
 * is set to the same 7 days (`provision.sh`), so a message cannot outlive its body.
 */
export const INTAKE_DAYS = 7;

/**
 * Deletes `intake/` objects past `INTAKE_DAYS` (or the personal data retention, if shorter): a raw
 * Shopify order or X12 interchange holds the buyer's details. The orders they started keep their own
 * erasure; a body is not filed under a person, so a subject's erasure can't find it and this expiry is
 * what removes it. Isolated: a failure is logged and tried again tomorrow, and never stops the sweep's
 * other steps. Returns how many it deleted.
 */
export async function expireIntake(env: Env, now = Date.now()) {
  try {
    const days = Math.min(
      INTAKE_DAYS,
      personalDataRetentionDays(env.PERSONAL_DATA_RETENTION_DAYS) ?? INTAKE_DAYS,
    );
    const cutoff = now - days * 86_400_000;
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const page = await env.DOCS.list({ prefix: 'intake/', cursor });
      const old = page.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
      if (old.length) await env.DOCS.delete(old);
      deleted += old.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return deleted;
  } catch (err) {
    console.error(JSON.stringify({ type: 'intake_expiry_failed', error: String(err) }));
    return 0;
  }
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
