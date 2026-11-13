/**
 * The mail queue's consumers (apps/engine/wrangler.jsonc, rendered per deployment: present with
 * `redundancy` and an `email` sender, absent with `email` an exception). Three queues, each with a
 * dead-letter queue, all suffixed with the deployment's name:
 *
 * - `commerceworker-email`: order confirmations (the `messages` row is filed first, the job names it)
 *   and sign-in codes whose inline first attempt failed (the rules are `deliverQueuedEmail`'s). A
 *   refusal is retried with a backoff; after the queue's retries the message lands in the dead-letter
 *   queue, which keeps it in the docs replica under `dlq/` (a sign-in's code redacted), logs it at
 *   error level and counts `failover('email_failed')`. The row stays unsent with its last error, so
 *   a confirmation can be found there too. `fleet.ts redrive` sends kept ones back.
 * - `commerceworker-email-events`: Email Sending's event subscription (delivered, bounced,
 *   complained...), recorded on the message whose binding id the event carries.
 *
 * Without a replica the dead letters are only logged, since there is nowhere to keep them.
 */
import {
  deliverQueuedEmail,
  recordEmailEvent,
  scrubQueuedEmail,
} from '@commerceworker/application/commerce';
import { backoff, keepDeadLetters } from './docs-replica';
import { ops } from './metrics';
import { ports, sender } from './order-confirmation';
import { messageStore } from './wire';

// Longest names first: `-events-dlq` and `-dlq` start like `-events` and the bare queue's, and a
// registry id can't be or start with `dlq` or `events` (scripts/fleet.ts), so a suffix never does.
export const isEmailEventsDlq = (q: string) => /^commerceworker-email-events-dlq(-|$)/.test(q);
export const isEmailEvents = (q: string) => /^commerceworker-email-events(-|$)/.test(q);
export const isEmailDlq = (q: string) => /^commerceworker-email-dlq(-|$)/.test(q);
export const isEmailQueue = (q: string) => /^commerceworker-email(-|$)/.test(q);

/** Sends each queued message; one that can't go is retried later, and past the queue's retries dead-lettered. */
export async function deliverEmails(batch: MessageBatch, env: Env): Promise<void> {
  const email = sender(env);
  await Promise.all(
    batch.messages.map(async (msg) => {
      try {
        const outcome = await deliverQueuedEmail({ ...ports(env), email }, msg.body, Date.now());
        if (outcome.status === 'retry') {
          console.warn(
            JSON.stringify({
              type: 'email_retry',
              id: msg.id,
              attempts: msg.attempts,
              error: outcome.error,
            }),
          );
          msg.retry({ delaySeconds: backoff(msg.attempts) });
          return;
        }
        if (outcome.status === 'unreadable')
          // Retrying can't make it a different message.
          console.error(
            JSON.stringify({ type: 'email_unreadable', queue: batch.queue, id: msg.id }),
          );
        else if (outcome.status === 'skipped')
          console.log(JSON.stringify({ type: 'email_skipped', id: msg.id, why: outcome.why }));
        msg.ack();
      } catch (err) {
        console.warn(
          JSON.stringify({ type: 'email_retry', id: msg.id, attempts: msg.attempts }),
          err,
        );
        msg.retry({ delaySeconds: backoff(msg.attempts) });
      }
    }),
  );
}

/** The mail queue's dead letters: kept (a code redacted), logged at error level, counted. */
export async function keepEmailDeadLetters(batch: MessageBatch, env: Env): Promise<void> {
  // Once per message: a retry of this consumer sees the same message with more attempts.
  for (const msg of batch.messages) if (msg.attempts <= 1) ops().failover('email_failed');
  await keepOrLog(batch, env);
}

/** The events queue's dead letters: kept and logged like the others, with no mail counted. */
export const keepEmailEventDeadLetters = keepOrLog;

async function keepOrLog(batch: MessageBatch, env: Env): Promise<void> {
  if (env.DOCS_REPLICA) return keepDeadLetters(batch, env, scrubQueuedEmail);
  for (const msg of batch.messages) {
    // Nowhere to keep it (no replica): the log line names the message, and the order's `messages`
    // row still says it never went.
    console.error(
      JSON.stringify({
        type: 'dlq_message',
        queue: batch.queue,
        id: msg.id,
        attempts: msg.attempts,
        kept: false,
      }),
    );
    msg.ack();
  }
}

/** Records Email Sending's events on the messages they name. */
export async function recordEmailEvents(batch: MessageBatch, env: Env): Promise<void> {
  const messages = messageStore(env);
  await Promise.all(
    batch.messages.map(async (msg) => {
      try {
        const r = await recordEmailEvent(messages, msg.body, Date.now());
        if (r.status === 'unmatched') {
          // An event can beat the `markSent` that stores its id; a sign-in code's mail has no row at
          // all. Wait a little, twice, then let it go.
          if (msg.attempts < 3) return msg.retry({ delaySeconds: 15 * msg.attempts });
          console.log(
            JSON.stringify({ type: 'email_event_unmatched', id: msg.id, delivery: r.delivery }),
          );
        } else if (
          r.status === 'recorded' &&
          r.delivery !== 'delivered' &&
          r.delivery !== 'deferred'
        )
          console.warn(
            JSON.stringify({ type: 'email_delivery_problem', id: msg.id, delivery: r.delivery }),
          );
        msg.ack();
      } catch (err) {
        console.warn(
          JSON.stringify({ type: 'email_event_retry', id: msg.id, attempts: msg.attempts }),
          err,
        );
        msg.retry({ delaySeconds: backoff(msg.attempts) });
      }
    }),
  );
}
