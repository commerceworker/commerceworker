/**
 * @commerceworker/sdk-core/webhooks — check that a webhook delivery came from your space.
 *
 * Each delivery is signed: `x-commerceworker-signature` is `sha256=` and the hex HMAC-SHA256 of
 * `<x-commerceworker-timestamp>.<raw body>` with the webhook's secret. `verifyWebhook` checks it in
 * constant time (Web Crypto, so it runs in browsers, Workers, Node, Deno and Bun) and rejects a
 * delivery whose timestamp is outside the freshness window. Zero dependencies.
 */

/** A webhook event: the type and id on every event, plus the fields its type carries. */
export interface WebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly [field: string]: unknown;
}

export interface VerifyWebhookOptions {
  /**
   * How far the timestamp may be from now, in milliseconds (default 5 minutes). A retry keeps the
   * event's original timestamp, so widen this to accept late retries, or deduplicate by `id`.
   */
  readonly toleranceMs?: number;
  /** The current time, for tests. */
  readonly now?: number;
}

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Whether `signature` is a valid signature of `body` at `timestamp`. Use `verifyWebhook` with a
 * `Request`; this is for frameworks that hand you the raw body and headers separately.
 */
export async function verifyWebhookSignature(input: {
  readonly body: string;
  readonly timestamp: string | null | undefined;
  readonly signature: string | null | undefined;
  readonly secret: string;
  readonly toleranceMs?: number;
  readonly now?: number;
}): Promise<boolean> {
  const { body, timestamp, signature, secret } = input;
  if (!secret || !timestamp || !signature?.startsWith('sha256=')) return false;
  const at = Date.parse(timestamp);
  const tolerance = input.toleranceMs ?? 5 * 60_000;
  if (!Number.isFinite(at) || Math.abs((input.now ?? Date.now()) - at) > tolerance) return false;
  const sig = hexToBytes(signature.slice('sha256='.length));
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  // `verify` compares in constant time.
  return crypto.subtle.verify('HMAC', key, sig, encoder.encode(`${timestamp}.${body}`));
}

/**
 * Reads a webhook delivery and returns its event if the signature and timestamp check out, or
 * `null` if they don't (answer 401 then). Reads the body itself, so pass the request unread.
 *
 *   const event = await verifyWebhook(request, env.WEBHOOK_SECRET);
 *   if (!event) return new Response('Invalid signature', { status: 401 });
 */
export async function verifyWebhook(
  request: Request,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent | null> {
  const body = await request.text();
  const ok = await verifyWebhookSignature({
    body,
    timestamp: request.headers.get('x-commerceworker-timestamp'),
    signature: request.headers.get('x-commerceworker-signature'),
    secret,
    ...options,
  });
  if (!ok) return null;
  try {
    const event = JSON.parse(body) as WebhookEvent;
    return typeof event?.type === 'string' ? event : null;
  } catch {
    return null;
  }
}
