/**
 * Verifies a signed CommerceWorker webhook delivery (an order or cart event sent to a webhook
 * subscription), as it arrives:
 *
 *   X-CommerceWorker-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>[,v1=…]
 *
 * (a signature from an integration also carries `k=<integration id>`). Runs on the Web Crypto API,
 * so it works in Node, Workers and browsers with no dependencies. Hand it the raw body, before any
 * JSON parsing: the signature covers the bytes that were sent.
 */

export type WebhookVerification =
  | {
      readonly ok: true;
      /** The signed timestamp, in unix seconds. */
      readonly timestamp: number;
      /** The integration the signature names (`k=`), when it names one. */
      readonly keyId?: string;
    }
  | { readonly ok: false; readonly reason: string };

export interface VerifyCommerceWebhookOptions {
  /** How far the signed timestamp may be from now, in seconds. Default 300. */
  readonly toleranceSec?: number;
  /** The time to check against, in unix seconds (for tests). Default now. */
  readonly nowSec?: number;
}

const enc = new TextEncoder();

/** `t=1,v1=a,v1=b` → `{ t: ['1'], v1: ['a', 'b'] }`: a key may repeat. */
function parts(header: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of header.split(',')) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const k = p.slice(0, i).trim();
    out.set(k, [...(out.get(k) ?? []), p.slice(i + 1).trim()]);
  }
  return out;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Compares every character of equal-length strings, so the time says nothing about where they differ. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, t: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const prefix = enc.encode(`${t}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, message)));
}

/**
 * Checks `header` against `body` with `secrets`: one secret, or several while one is being rotated
 * (a signature made with any of them passes). Never throws on a bad input; read `ok` and `reason`.
 */
export async function verifyCommerceWebhook(
  body: string | Uint8Array,
  header: string | null | undefined,
  secrets: string | readonly string[],
  { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) }: VerifyCommerceWebhookOptions = {},
): Promise<WebhookVerification> {
  if (!header) return { ok: false, reason: 'Missing signature header' };
  const p = parts(header);
  const tRaw = p.get('t')?.[0];
  const t = Number(tRaw);
  const given = (p.get('v1') ?? []).filter(Boolean).map((v) => v.toLowerCase());
  if (!tRaw || !Number.isFinite(t) || !given.length)
    return { ok: false, reason: 'Malformed signature header' };
  if (Math.abs(nowSec - t) > toleranceSec)
    return { ok: false, reason: 'Timestamp outside the tolerance' };

  const bytes = typeof body === 'string' ? enc.encode(body) : body;
  let match = false;
  for (const secret of typeof secrets === 'string' ? [secrets] : secrets) {
    const expected = await hmacHex(secret, String(t), bytes);
    // Every candidate is compared, so the time taken doesn't say which one matched.
    for (const v of given) match = equal(expected, v) || match;
  }
  if (!match) return { ok: false, reason: 'Signature mismatch' };
  const keyId = p.get('k')?.[0];
  return { ok: true, timestamp: t, ...(keyId ? { keyId } : {}) };
}
