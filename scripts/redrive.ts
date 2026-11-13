/**
 * `node scripts/fleet.ts redrive <id> <queue> [date]`: sends the dead letters a queue's consumer kept
 * (`dlq/<dead-letter queue>/<date>/<id>.json` in R2) back to the queue they failed on.
 *
 * What to send is decided by `redrivePlan` and `redriveBody`, pure and tested; `redrive` runs the plan
 * against R2's S3 API and the Queues HTTP API (`RedriveIo`), which needs an operator's credentials
 * (docs/operations.md, "Redriving dead letters") and is never run in CI. A message is redriven at most
 * once: its marker (`dlq/redriven/<dlq>/<date>/<id>.json`, beside what it marks, so the same 30-day
 * lifecycle expires it) is written before the send, and removed again only if the send itself
 * failed. A crash between the two leaves a marker with nothing sent, which a reader sees as
 * "redriven" and an operator can delete to try again.
 */
import { createHash, createHmac } from 'node:crypto';

/** Where a dead letter is kept and where it goes back to. */
export type RedriveTarget = {
  /** The name an operator gives: `email`, `docs-replica`, `catalog-changes`... */
  name: string;
  /** The bucket holding `dlq/`, by its role in `names()` (the replica's or the catalog's). */
  bucket: 'docsReplica' | 'catalogR2';
  dlq: string;
  queue: string;
};

const KEY = /^dlq\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/([^/]+\.json)$/;
export const markerKey = (dlq: string, date: string, file: string) =>
  `dlq/redriven/${dlq}/${date}/${file}`;

export type RedrivePlan = {
  send: { key: string; marker: string }[];
  skipped: { key: string; reason: string }[];
};

/**
 * Which kept objects to send: those under `dlq/<dlq>/` (of `date` only, when given) that no marker
 * covers. `keys` are the object keys listed under `dlq/<dlq>/`, `markers` those under
 * `dlq/redriven/<dlq>/`. Oldest first, so a redrive keeps the order the messages died in.
 */
export function redrivePlan(input: {
  dlq: string;
  date?: string;
  keys: readonly string[];
  markers: readonly string[];
}): RedrivePlan {
  if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date))
    throw new Error(`date must be YYYY-MM-DD (got "${input.date}")`);
  const done = new Set(input.markers);
  const plan: RedrivePlan = { send: [], skipped: [] };
  for (const key of [...input.keys].sort()) {
    const m = KEY.exec(key);
    if (!m || m[1] !== input.dlq) {
      plan.skipped.push({ key, reason: 'not a dead letter of this queue' });
      continue;
    }
    if (input.date && m[2] !== input.date) continue;
    const marker = markerKey(input.dlq, m[2] as string, m[3] as string);
    if (done.has(marker)) plan.skipped.push({ key, reason: 'already redriven' });
    else plan.send.push({ key, marker });
  }
  return plan;
}

/** The body to send back for a kept object's text, or why not: a sign-in code's was redacted when kept. */
export function redriveBody(text: string): { body: unknown } | { skip: string } {
  let kept: { body?: unknown };
  try {
    kept = JSON.parse(text);
  } catch {
    return { skip: 'unreadable' };
  }
  if (!kept || typeof kept !== 'object' || !('body' in kept)) return { skip: 'no body' };
  const body = kept.body as { redacted?: unknown } | null;
  if (body && typeof body === 'object' && body.redacted === true)
    return { skip: 'redacted when kept: its code is gone' };
  return { body: kept.body };
}

/** What a redrive does to the world; the real one is below, a test's is in memory. */
export interface RedriveIo {
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<string>;
  put(key: string, body: string): Promise<void>;
  remove(key: string): Promise<void>;
  send(body: unknown): Promise<void>;
}

export type RedriveReport = {
  sent: string[];
  skipped: { key: string; reason: string }[];
  failed: { key: string; error: string }[];
};

export async function redrive(
  io: RedriveIo,
  target: Pick<RedriveTarget, 'dlq'>,
  date: string | undefined,
  dryRun = false,
): Promise<RedriveReport> {
  const plan = redrivePlan({
    dlq: target.dlq,
    date,
    keys: await io.list(`dlq/${target.dlq}/`),
    markers: await io.list(`dlq/redriven/${target.dlq}/`),
  });
  const report: RedriveReport = { sent: [], skipped: [...plan.skipped], failed: [] };
  for (const { key, marker } of plan.send) {
    try {
      const read = redriveBody(await io.get(key));
      if ('skip' in read) {
        report.skipped.push({ key, reason: read.skip });
        continue;
      }
      if (dryRun) {
        report.sent.push(key);
        continue;
      }
      await io.put(marker, JSON.stringify({ key, at: new Date().toISOString() }));
      try {
        await io.send(read.body);
      } catch (err) {
        // Nothing was sent, so the next run may try it again.
        await io.remove(marker);
        throw err;
      }
      report.sent.push(key);
    } catch (err) {
      report.failed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

// --- The operator's side: R2's S3 API and the Queues HTTP API ---

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s).digest();

/** An AWS Signature V4 `Authorization` for an R2 request (service `s3`, region `auto`). */
export function signR2(
  req: { method: string; host: string; path: string; query: string; payloadHash: string; at: Date },
  creds: { accessKeyId: string; secretAccessKey: string },
): Record<string, string> {
  const stamp = req.at.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);
  const headers = {
    host: req.host,
    'x-amz-content-sha256': req.payloadHash,
    'x-amz-date': stamp,
  };
  const signed = Object.keys(headers).join(';');
  const canonical = [
    req.method,
    req.path,
    req.query,
    Object.entries(headers)
      .map(([k, v]) => `${k}:${v}\n`)
      .join(''),
    signed,
    req.payloadHash,
  ].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), 'auto'), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}

const enc = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** The keys and the continuation token in a ListObjectsV2 answer. */
export function parseList(xml: string): { keys: string[]; next?: string } {
  const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) =>
    (m[1] as string).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
  );
  const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { keys, ...(next ? { next } : {}) };
}

export type OperatorEnv = {
  accountId: string;
  apiToken: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** The credentials from the environment, or what is missing. */
export function operatorEnv(env: NodeJS.ProcessEnv): OperatorEnv {
  const want = {
    accountId: 'CLOUDFLARE_ACCOUNT_ID',
    apiToken: 'CLOUDFLARE_API_TOKEN',
    accessKeyId: 'R2_ACCESS_KEY_ID',
    secretAccessKey: 'R2_SECRET_ACCESS_KEY',
  } as const;
  const missing = Object.values(want).filter((n) => !env[n]);
  if (missing.length) throw new Error(`redrive needs ${missing.join(', ')} in the environment`);
  return Object.fromEntries(Object.entries(want).map(([k, n]) => [k, env[n]])) as OperatorEnv;
}

export function cloudflareIo(
  op: OperatorEnv,
  where: { bucket: string; queue: string; jurisdiction?: string },
): RedriveIo {
  const host = `${op.accountId}.${where.jurisdiction ? `${where.jurisdiction}.` : ''}r2.cloudflarestorage.com`;
  const s3 = async (method: string, key: string, query: string, body?: string) => {
    const payloadHash = sha256(body ?? '');
    const path = `/${where.bucket}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`;
    const res = await fetch(`https://${host}${path}${query ? `?${query}` : ''}`, {
      method,
      headers: signR2({ method, host, path, query, payloadHash, at: new Date() }, op),
      ...(body !== undefined ? { body } : {}),
    });
    if (!res.ok) throw new Error(`R2 ${method} ${key || where.bucket}: ${res.status}`);
    return res.text();
  };
  let queueId: string | undefined;
  const api = (path: string, init?: RequestInit) =>
    fetch(`https://api.cloudflare.com/client/v4/accounts/${op.accountId}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${op.apiToken}`, 'content-type': 'application/json' },
    });
  return {
    async list(prefix) {
      const out: string[] = [];
      let token: string | undefined;
      do {
        // Query parameters sorted by name, as the signature wants.
        const q = [
          ...(token ? [`continuation-token=${enc(token)}`] : []),
          'list-type=2',
          `prefix=${enc(prefix)}`,
        ].join('&');
        const page = parseList(await s3('GET', '', q));
        out.push(...page.keys);
        token = page.next;
      } while (token);
      return out;
    },
    get: (key) => s3('GET', key, ''),
    put: async (key, body) => void (await s3('PUT', key, '', body)),
    remove: async (key) => void (await s3('DELETE', key, '')),
    async send(body) {
      if (!queueId) {
        const found = (await (await api('/queues?per_page=100')).json()) as {
          result?: { queue_id: string; queue_name: string }[];
        };
        queueId = found.result?.find((q) => q.queue_name === where.queue)?.queue_id;
        if (!queueId) throw new Error(`queue ${where.queue} not found in the account`);
      }
      const res = await api(`/queues/${queueId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`Queues push: ${res.status}`);
    },
  };
}
