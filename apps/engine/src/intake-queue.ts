/**
 * The channel intake queue's consumers (apps/engine/wrangler.jsonc, rendered per deployment: present
 * with `redundancy` unless `intake` is an exception). `commerceworker-intake` carries a pointer to a
 * Shopify order webhook or an EDI 850 interchange the web app verified and wrote to `DOCS`
 * (`intake/<channel>/<date>/<id>`) before it answered `202`. The consumer reads that body, maps it with
 * the same functions the web app checked it with, and starts each order once per channel and external
 * id (`startOrderOnce`), so a redelivery, a webhook Shopify sent twice or an interchange a partner
 * resent starts nothing twice.
 *
 * Anything that stops an order starting (the engine unreachable, the body not yet readable, a flow not
 * published, a currency with no rate) is retried with a backoff, so a fix made meanwhile still lets it
 * through; after the queue's retries the message lands in the dead-letter queue, which keeps it in the
 * docs replica under `dlq/` (the body stays in `DOCS`) and logs it at error level, which is the alert.
 * `fleet.ts redrive` sends kept ones back.
 * Without a replica the dead letters are only logged, with the key of the body.
 */
import {
  type InboundOrder,
  type IntakeMessage,
  inboundFingerprint,
  isIntakeMessage,
  mapEdiIntake,
  mapShopifyIntake,
  toStartRequest,
} from '@commerceworker/core';
import { recordAudit } from './audit';
import { backoff, keepDeadLetters } from './docs-replica';
import { ensureTemplates } from './flows';
import { ops } from './metrics';
import { fromOutside, startOrderOnce } from './orders';
import { docsReader, pricingStore } from './wire';

// `-dlq` starts like the queue's own name; a registry id can't be or start with `dlq` (scripts/fleet.ts).
export const isIntakeDlq = (q: string) => /^commerceworker-intake-dlq(-|$)/.test(q);
export const isIntakeQueue = (q: string) => /^commerceworker-intake(-|$)/.test(q);

/** The customer a Shopify buyer's email belongs to: this exact address only. */
async function customerIdByEmail(env: Env, email: string | null | undefined) {
  const wanted = email?.trim().toLowerCase();
  if (!wanted) return undefined;
  const found = await pricingStore(env).customersByEmail(
    wanted,
    wanted.split('@').at(-1) ?? wanted,
  );
  return found.find((c) => c.email.toLowerCase() === wanted)?.id;
}

/**
 * An order that can never start however often it is tried (a replay with different contents): the
 * message is not retried for it, and the rest of an interchange goes on.
 */
class RefusedError extends Error {}

/** A refusal a person has to look at: logged at error level (which alerts) and counted. */
function refused(msg: IntakeMessage, what: string, err: unknown) {
  console.error(
    JSON.stringify({
      type: 'intake_order_refused',
      channel: msg.channel,
      key: msg.key,
      order: what,
      reason: err instanceof Error ? err.message : String(err),
    }),
  );
  ops().reconcileMismatch('intake');
}

/** Starts one mapped order; a failure throws, so the message is retried. */
async function startOne(
  env: Env,
  o: InboundOrder,
  flowId: string,
  who: { actor: { kind: string; id: string; name: string }; via: 'webhook' | 'api' },
  purchaseOrder?: { poNumber: string },
) {
  if ((await pricingStore(env).fxRate(o.currency)) === null)
    throw new Error(`Unsupported currency ${o.currency}; there is no exchange rate for it`);
  const res = await startOrderOnce(
    env,
    fromOutside({
      ...toStartRequest(o, flowId),
      ...(purchaseOrder
        ? { purchaseOrder: { record: { source: 'edi' as const, ...purchaseOrder } } }
        : {}),
      fingerprint: await inboundFingerprint(o),
    }),
  );
  if ('mismatch' in res)
    throw new RefusedError(
      `Order ${o.externalId} on ${o.channel} was already received with different contents`,
    );
  // The audit event of a first start only: a replay is the same order again.
  if (!res.replayed)
    await recordAudit(env, 'order.started', {
      actor: who.actor,
      target: res.orderId,
      detail: { flowId, channel: o.channel, externalId: o.externalId, via: who.via },
    });
  return res;
}

/** Reads the body and starts every order in it. */
export async function startIntake(env: Env, msg: IntakeMessage): Promise<number> {
  const obj = await docsReader(env).get(msg.key);
  if (!obj) throw new Error(`Intake body ${msg.key} is not in DOCS`);
  const raw = await obj.text();
  await ensureTemplates(env);
  if (msg.channel === 'shopify') {
    // Mapped once to read the buyer's email, then with the customer it names.
    const first = mapShopifyIntake(raw);
    if (!first.ok) {
      // Accepted by the web app, so this is a body that changed or a mapping that did: not retried.
      refused(msg, 'shopify', new RefusedError(first.error));
      return 0;
    }
    const email = (JSON.parse(raw) as { email?: string | null }).email;
    const customerId = await customerIdByEmail(env, email);
    const mapped = customerId ? mapShopifyIntake(raw, customerId) : first;
    if (!mapped.ok) {
      refused(msg, 'shopify', new RefusedError(mapped.error));
      return 0;
    }
    try {
      await startOne(env, mapped.order, msg.flowId, {
        actor: { kind: 'channel', id: `shopify:${msg.shop}`, name: `shopify:${msg.shop}` },
        via: 'webhook',
      });
    } catch (err) {
      if (!(err instanceof RefusedError)) throw err;
      refused(msg, mapped.order.externalId, err);
      return 0;
    }
    return 1;
  }
  const mapped = mapEdiIntake(raw, { sender: msg.sender, customerId: msg.customerId });
  if (!mapped.ok) throw new Error(mapped.error);
  let started = 0;
  let transient: unknown;
  // In interchange order. A PO that can never start is logged and skipped; one that fails for a
  // cause that may pass (the database, a flow not yet published) is retried with the message, after
  // the rest have had their turn (the ones already started replay as the same orders).
  for (const m of mapped.orders) {
    // Refused when it was accepted (the 997 said so), or in a currency it had no rate for then.
    const flowId = m.ok ? msg.flows[m.control ?? ''] : undefined;
    if (!m.ok || !flowId) continue;
    try {
      await startOne(
        env,
        m.order,
        flowId,
        { actor: { ...msg.actor, name: msg.actor.id }, via: 'api' },
        { poNumber: m.poNumber! },
      );
      started++;
    } catch (err) {
      if (err instanceof RefusedError) refused(msg, m.poNumber ?? m.control ?? '', err);
      else transient ??= err;
    }
  }
  if (transient) throw transient;
  return started;
}

/** Starts the orders of each message; one that can't start is retried later, and past the queue's retries dead-lettered. */
export async function startIntakeOrders(batch: MessageBatch, env: Env): Promise<void> {
  // One at a time: a batch is a few webhooks, and each may write the same customer's order rows.
  for (const msg of batch.messages) {
    if (!isIntakeMessage(msg.body)) {
      // Retrying can't make it a different message; the dead-letter queue keeps nothing for it, so
      // it is only logged.
      console.error(JSON.stringify({ type: 'intake_unreadable', queue: batch.queue, id: msg.id }));
      msg.ack();
      continue;
    }
    try {
      const started = await startIntake(env, msg.body);
      console.log(
        JSON.stringify({
          type: 'intake_started',
          channel: msg.body.channel,
          key: msg.body.key,
          orders: started,
        }),
      );
      msg.ack();
    } catch (err) {
      console.warn(
        JSON.stringify({
          type: 'intake_retry',
          channel: msg.body.channel,
          key: msg.body.key,
          id: msg.id,
          attempts: msg.attempts,
        }),
        err,
      );
      msg.retry({ delaySeconds: backoff(msg.attempts) });
    }
  }
}

/** The intake queue's dead letters: kept in the replica (the body stays in `DOCS`), logged at error level. */
export async function keepIntakeDeadLetters(batch: MessageBatch, env: Env): Promise<void> {
  if (env.DOCS_REPLICA) return keepDeadLetters(batch, env);
  for (const msg of batch.messages) {
    // Nowhere to keep it (no replica): the log line names the body, which is still in DOCS.
    console.error(
      JSON.stringify({
        type: 'dlq_message',
        queue: batch.queue,
        id: msg.id,
        attempts: msg.attempts,
        kept: false,
        key: (msg.body as { key?: unknown } | null)?.key,
      }),
    );
    msg.ack();
  }
}
