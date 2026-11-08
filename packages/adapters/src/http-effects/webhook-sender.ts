import { createHmac } from 'node:crypto';
import type { DomainEvent, Webhook } from '@commerceworker/domain';
import type { WebhookSender, WebhookSendOptions, WebhookSendResult } from '@commerceworker/ports';

/**
 * HMAC-signing webhook sender. Posts the event as JSON with an
 * `X-CW-Signature: sha256=<hex>` header so receivers can verify authenticity,
 * plus a timestamp to bound replay and the event id to dedupe on. Network/HTTP errors surface as
 * `delivered: false` so the queue can retry.
 *
 * Uses `node:crypto` — available on Node and on Cloudflare Workers via the
 * `nodejs_compat` compatibility flag.
 */
export function createWebhookSender(
  fetchImpl: typeof fetch = fetch,
  opts: { timeoutMs?: number } = {},
): WebhookSender {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    async send(
      webhook: Webhook,
      payload: DomainEvent,
      opts: WebhookSendOptions = {},
    ): Promise<WebhookSendResult> {
      const body = JSON.stringify(payload);
      const timestamp = opts.timestamp ?? payload.occurredAt;
      const signature = createHmac('sha256', webhook.secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
      try {
        const res = await fetchImpl(webhook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-commerceworker-signature': `sha256=${signature}`,
            'x-commerceworker-timestamp': timestamp,
            'x-commerceworker-event': payload.type,
            // The id to dedupe on: a retry and a resend carry the same one.
            'x-commerceworker-event-id': payload.id,
            ...(opts.resendOf !== undefined
              ? { 'x-commerceworker-resend-of': String(opts.resendOf) }
              : {}),
            ...webhook.headers,
          },
          body,
          // Do not chase 3xx redirects — a redirect to an internal address would
          // turn a validated public target into an SSRF. Treat it as a failure.
          redirect: 'manual',
          // A hung receiver must not occupy the dispatching consumer for the
          // platform's default socket timeout; a timeout is just a failed
          // delivery, retried by the queue like any other.
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { delivered: res.ok, statusCode: res.status };
      } catch (err) {
        return { delivered: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
