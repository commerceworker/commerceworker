/**
 * What the mail queue's consumer does with a message, and with Email Sending's event for one it
 * sent (the engine's `email-queue.ts` binds the queues, the senders and the clock).
 *
 * `deliverQueuedEmail` sends a queued job and answers whether the queue should try it again. A
 * confirmation is sent through `sendOrderConfirmation` without a queue, so the `messages` row keyed
 * by the order decides: a redelivery that finds `sent_at` set sends nothing. A sign-in code is
 * dropped unsent once its code has expired (the person has asked again or given up, and the job's
 * body is the code, so it must not outlive it). Email Sending's binding has no idempotency key,
 * so a crash between its accepting a message and `markSent` can still send it twice.
 *
 * `recordEmailEvent` reads one of Email Sending's event subscription messages (`cf.email.sending.
 * message.<status>`) and records its status on the message the binding returned that id for.
 */
import type { EmailSender, QueuedEmail } from '@commerceworker/ports';
import type { MessageDelivery, MessageStore } from '@commerceworker/ports/commerce';
import { type OrderConfirmationPorts, sendOrderConfirmation } from './order-confirmation';

/** A queued job, or null for a body that is none: retrying can't make it one. */
export function queuedEmail(body: unknown): QueuedEmail | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return null;
  if (b.kind === 'confirmation') {
    return typeof b.orderId === 'string' && typeof b.messageId === 'string'
      ? { kind: 'confirmation', orderId: b.orderId, messageId: b.messageId }
      : null;
  }
  if (b.kind === 'sign_in') {
    return typeof b.to === 'string' &&
      typeof b.subject === 'string' &&
      typeof b.text === 'string' &&
      typeof b.expiresAt === 'number'
      ? {
          kind: 'sign_in',
          to: b.to,
          subject: b.subject,
          text: b.text,
          ...(typeof b.html === 'string' ? { html: b.html } : {}),
          expiresAt: b.expiresAt,
        }
      : null;
  }
  return null;
}

/** What the body of a dead letter keeps: a sign-in's is the code, and a dead letter is kept. */
export function scrubQueuedEmail(body: unknown): unknown {
  const job = queuedEmail(body);
  return job?.kind === 'sign_in'
    ? { kind: 'sign_in', redacted: true, expiresAt: job.expiresAt }
    : body;
}

export type QueuedEmailOutcome =
  | { status: 'sent' }
  /** Nothing to send: already sent, expired, or the deployment can't send. */
  | { status: 'skipped'; why: string }
  /** A body that is no job. */
  | { status: 'unreadable' }
  /** Try again later (and, once the queue's retries are spent, to the dead-letter queue). */
  | { status: 'retry'; error: string };

export type QueuedEmailPorts = Omit<OrderConfirmationPorts, 'queue'>;

export async function deliverQueuedEmail(
  ports: QueuedEmailPorts,
  body: unknown,
  now: number,
): Promise<QueuedEmailOutcome> {
  const job = queuedEmail(body);
  if (!job) return { status: 'unreadable' };
  if (job.kind === 'confirmation') {
    const r = await sendOrderConfirmation(ports, job.orderId, now);
    if (r.status === 'sent') return { status: 'sent' };
    if (r.status === 'failed') return { status: 'retry', error: r.error };
    return { status: 'skipped', why: r.status };
  }
  if (now >= job.expiresAt) return { status: 'skipped', why: 'expired' };
  if (!ports.email) return { status: 'skipped', why: 'not_configured' };
  return sendOnce(ports.email, job);
}

async function sendOnce(
  email: EmailSender,
  job: Extract<QueuedEmail, { kind: 'sign_in' }>,
): Promise<QueuedEmailOutcome> {
  try {
    const r = await email.send({
      to: [job.to],
      subject: job.subject,
      text: job.text,
      ...(job.html ? { html: job.html } : {}),
    });
    return r.delivered ? { status: 'sent' } : { status: 'retry', error: r.error ?? 'refused' };
  } catch (err) {
    return { status: 'retry', error: err instanceof Error ? err.message : String(err) };
  }
}

const EVENT_STATUS: Record<string, MessageDelivery> = {
  'cf.email.sending.message.delivered': 'delivered',
  'cf.email.sending.message.deferred': 'deferred',
  'cf.email.sending.message.bounced': 'bounced',
  'cf.email.sending.message.failed': 'failed',
  'cf.email.sending.message.rejected': 'rejected',
  'cf.email.sending.message.complained': 'complained',
};

export type EmailEventOutcome =
  | { status: 'recorded'; delivery: MessageDelivery }
  /** No message here has that id (yet): a sign-in code's mail has none, and an event can beat `markSent`. */
  | { status: 'unmatched'; delivery: MessageDelivery }
  /** Not an Email Sending message event we read. */
  | { status: 'ignored' };

export async function recordEmailEvent(
  messages: Pick<MessageStore, 'recordDelivery'>,
  body: unknown,
  now: number,
): Promise<EmailEventOutcome> {
  const e = body as {
    type?: unknown;
    payload?: {
      messageId?: unknown;
      delivery?: { smtpResponse?: unknown };
      bounce?: { reason?: unknown };
    };
    metadata?: { eventTimestamp?: unknown };
  } | null;
  const delivery = typeof e?.type === 'string' ? EVENT_STATUS[e.type] : undefined;
  const id = e?.payload?.messageId;
  if (!delivery || typeof id !== 'string' || !id) return { status: 'ignored' };
  const reason = e?.payload?.bounce?.reason ?? e?.payload?.delivery?.smtpResponse;
  const stamp =
    typeof e?.metadata?.eventTimestamp === 'string' ? Date.parse(e.metadata.eventTimestamp) : NaN;
  const found = await messages.recordDelivery(
    id,
    delivery,
    Number.isFinite(stamp) ? stamp : now,
    typeof reason === 'string' ? reason : undefined,
  );
  return { status: found ? 'recorded' : 'unmatched', delivery };
}
