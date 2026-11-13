import { env } from 'cloudflare:workers';
import { type IntakeMessage, intakeKey } from '@commerceworker/core';

/**
 * The intake queue's producer (`INTAKE_QUEUE`), bound by scripts/fleet.ts with the registry's
 * `redundancy` unless `intake` is an exception. Unbound (local development, a deployment without the
 * flag) a Shopify webhook or EDI interchange starts its orders before it answers, as it always did.
 */
export const intakeQueue = () => (env as { INTAKE_QUEUE?: Queue<IntakeMessage> }).INTAKE_QUEUE;

/** A body's SHA-256, hex: names an interchange, and a webhook that carries no id of its own. */
async function digest(raw: string) {
  const sum = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(sum)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Makes a verified body durable before anything else happens to it: the raw bytes go to `DOCS` at
 * `intake/<channel>/<date>/<id>`, then a pointer to the queue. A repeat of the same delivery writes
 * the same key. Throws when either fails, so the caller answers 503 and the sender retries.
 */
export async function acceptIntake<T extends IntakeMessage>(
  raw: string,
  channel: T['channel'],
  id: string | null,
  message: (key: string, receivedAt: number) => Omit<T, 'key' | 'receivedAt' | 'channel'>,
): Promise<string> {
  const queue = intakeQueue();
  if (!queue) throw new Error('No intake queue is bound');
  const now = new Date();
  const safe = id?.replace(/[^\w.-]/g, '_').slice(0, 80);
  const key = intakeKey(channel, now, safe || (await digest(raw)).slice(0, 40));
  await env.DOCS.put(key, raw, {
    httpMetadata: { contentType: channel === 'shopify' ? 'application/json' : 'text/plain' },
  });
  await queue.send({
    channel,
    key,
    receivedAt: now.getTime(),
    ...message(key, now.getTime()),
  } as T);
  return key;
}
