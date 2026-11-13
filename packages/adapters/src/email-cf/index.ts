import type { EmailMessage, EmailSender, EmailSendResult } from '@commerceworker/ports';

/**
 * Cloudflare Email Sending adapter for the `EmailSender` port.
 *
 * The Worker's `send_email` binding (`env.EMAIL`) sends transactional mail from a domain onboarded
 * to Email Sending; no API key is involved. The binding is typed structurally here, so the package
 * imports no Cloudflare types: the edge passes `env.EMAIL` straight in.
 *
 * The binding has no idempotency key. A workflow `content.notify` node sends inside a durable
 * step, so a finished send is never repeated on replay; only a send whose step failed after the
 * binding accepted it can repeat, and a failed send reports `delivered: false` so the step retries.
 */

/** A named address, as the binding takes it. */
export interface SendEmailAddress {
  readonly email: string;
  readonly name: string;
}

/** The slice of Cloudflare's `SendEmail` binding this adapter uses (its builder form). */
export interface SendEmailBinding {
  send(message: {
    from: string | SendEmailAddress;
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

export interface CfEmailSenderOptions {
  /** The sender address; its domain must be onboarded to Email Sending. */
  readonly from: string;
  /** Display name for the sender. */
  readonly fromName?: string;
  /** Recipients per message; Email Sending caps a message's recipients (default 50). */
  readonly maxRecipients?: number;
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * The errors a second sender can answer: the primary's sender domain isn't (or is no longer)
 * onboarded, or Email Sending itself failed (its only 5xx). Anything else would fail the same
 * from the fallback's domain, since it is the same account: a bad recipient or message, a rate or
 * daily limit, a suspended account. Those are left to the queue's retries or the caller. Codes are
 * from the Workers binding's error table (Email Service, "Email Sending Workers API").
 */
export const FALLBACK_CODES: ReadonlySet<string> = new Set([
  'E_SENDER_NOT_VERIFIED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_INTERNAL_SERVER_ERROR',
]);

/**
 * `primary`, then `fallback` when the primary refuses with one of `FALLBACK_CODES`. The fallback's
 * answer is the answer (and says it was the fallback in `error` if it fails too, so a log shows both).
 * The binding has no idempotency key, so a primary that failed after accepting the message could
 * send it twice; the listed codes are all refusals before acceptance.
 */
export function withFallbackSender(primary: EmailSender, fallback: EmailSender): EmailSender {
  return {
    async send(message) {
      const first = await primary.send(message);
      if (first.delivered || !first.code || !FALLBACK_CODES.has(first.code)) return first;
      const second = await fallback.send(message);
      return second.delivered
        ? second
        : {
            ...second,
            error: `${first.error ?? first.code}; fallback: ${second.error ?? 'failed'}`,
          };
    },
  };
}

/** Builds an `EmailSender` over the `send_email` binding. Throws on an unusable `from`. */
export function createCfEmailSender(
  binding: SendEmailBinding,
  options: CfEmailSenderOptions,
): EmailSender {
  const from = options.from.trim();
  if (!ADDRESS.test(from)) {
    throw new Error(`EMAIL_FROM must be an email address on an onboarded domain (got "${from}")`);
  }
  const sender: string | SendEmailAddress = options.fromName?.trim()
    ? { email: from, name: options.fromName.trim() }
    : from;
  const max = options.maxRecipients ?? 50;

  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      const to = [...new Set(message.to.map((t) => t.trim()).filter(Boolean))];
      if (to.length === 0) return { delivered: false, error: 'No recipients' };
      const bad = to.find((t) => !ADDRESS.test(t));
      if (bad) return { delivered: false, error: 'Not an email address' };
      if (to.length > max) {
        return { delivered: false, error: `At most ${max} recipients per message` };
      }
      try {
        const sent = await binding.send({
          from: sender,
          to: to.length === 1 ? (to[0] as string) : to,
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        });
        return { delivered: true, id: sent.messageId };
      } catch (err) {
        // Binding errors carry a code (e.g. E_SENDER_NOT_VERIFIED); keep it in the message.
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code: unknown }).code)
            : '';
        const text = err instanceof Error ? err.message : String(err);
        return {
          delivered: false,
          error: code && !text.includes(code) ? `${code}: ${text}` : text,
          ...(code ? { code } : {}),
        };
      }
    },
  };
}
