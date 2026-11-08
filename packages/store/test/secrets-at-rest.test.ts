import {
  createSecretSealer,
  resealSecrets,
  secretContext,
  withSealedSecrets,
} from '@commerceworker/application';
import type { ContentStore, StoredSecretRepo } from '@commerceworker/ports';
import { afterAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

const uuidv7 = () => crypto.randomUUID();

/**
 * Secrets at rest against D1: the sealed values land in the
 * columns, the raw `storedSecrets` scan/compare-and-set SQL behaves like the
 * in-memory contract, and the sweep reseals end to end.
 *
 * Every row id shares this run's prefix, and the sweep runs over a view of
 * `storedSecrets` restricted to that prefix — a shared developer database's
 * other webhooks are never resealed under the test key.
 */
const KEY = 'contract-test-data-key-0123456789abcdef01234';
const OLD = 'contract-test-old-data-key-0123456789abcdef0';

describe('D1 secrets at rest (contract)', () => {
  const d1 = createD1Store(testDb);
  const run = `sec-${uuidv7()}`;
  const scope = { spaceId: run, environmentId: 'main' };
  const sealer = createSecretSealer({ current: KEY });

  /** `storedSecrets` restricted to this run's rows (contiguous in byte order). */
  const mine = (repo: StoredSecretRepo): StoredSecretRepo => ({
    scan: async (column, opts) => {
      const after = opts.after && opts.after.id >= run ? opts.after : { id: run, key: undefined };
      const rows = await repo.scan(column, { ...opts, after });
      return rows.filter((r) => r.id.startsWith(`${run}-`));
    },
    replace: (ref, was, next) => repo.replace(ref, was, next),
  });

  const rawSecret = async (id: string) => {
    const row = await testDb
      .prepare('select secret, headers from webhooks where id = ?')
      .bind(id)
      .first<{ secret: string; headers: string | null }>();
    return row
      ? {
          secret: row.secret,
          headers: row.headers ? (JSON.parse(row.headers) as Record<string, string>) : null,
        }
      : undefined;
  };

  const oldSealer = createSecretSealer({ current: OLD });
  /** A row sealed under the key the deployment has rotated away from. */
  const oldRow = (id: string, secret: string, headers?: Record<string, string>) =>
    withSealedSecrets(d1, oldSealer).webhooks.create(scope, {
      id,
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret,
      active: true,
      environmentId: null,
      ...(headers ? { headers } : {}),
    });

  afterAll(async () => {
    await testDb.prepare('delete from webhooks where space_id = ?').bind(run).run();
  });

  it('stores sealed values and reads plaintext through the decorator', async () => {
    const store: ContentStore = withSealedSecrets(d1, sealer);
    const id = `${run}-a`;
    await store.webhooks.create(scope, {
      id,
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret: 'whsec_pg',
      active: true,
      environmentId: null,
      headers: { Authorization: 'Bearer d1', 'X-Other': 'v' },
    });
    const row = await rawSecret(id);
    expect(row?.secret.startsWith(await sealer.currentPrefix())).toBe(true);
    expect(Object.keys(row?.headers ?? {}).sort()).toEqual(['Authorization', 'X-Other']);
    expect(row?.headers?.Authorization).toMatch(/^e1\./);

    const w = await store.webhooks.get(scope, id);
    expect(w?.secret).toBe('whsec_pg');
    expect(w?.headers).toEqual({ Authorization: 'Bearer d1', 'X-Other': 'v' });
  });

  it('scans only values not under the current key, in (id, key) order', async () => {
    await oldRow(`${run}-b`, 'whsec_b', { B: 'b2', A: 'a2' });
    const repo = mine(d1.storedSecrets);
    const excludePrefix = await sealer.currentPrefix();
    const oldPrefix = await oldSealer.currentPrefix();

    const secrets = await repo.scan('webhooks.secret', { excludePrefix, limit: 100 });
    expect(secrets.map((r) => r.id)).toEqual([`${run}-b`]);
    expect(secrets[0]?.value.startsWith(oldPrefix)).toBe(true);

    const headers = await repo.scan('webhooks.headers', { excludePrefix, limit: 100 });
    expect(headers.map((r) => [r.id, r.key])).toEqual([
      [`${run}-b`, 'A'],
      [`${run}-b`, 'B'],
    ]);

    // Cursor: strictly after (id, key).
    const rest = await repo.scan('webhooks.headers', {
      excludePrefix,
      limit: 100,
      after: { id: `${run}-b`, key: 'A' },
    });
    expect(rest.map((r) => r.key)).toEqual(['B']);
  });

  it('compare-and-set writes only over the value it read', async () => {
    // The repo stores opaque strings; this row exercises the SQL alone and is
    // removed before the sweep runs.
    const id = `${run}-c`;
    await d1.webhooks.create(scope, {
      id,
      url: 'https://hook.example/cw',
      topics: ['*'],
      secret: 's1',
      active: true,
      environmentId: null,
      headers: { K: 'v1', Keep: 'kept' },
    });
    const ref = { column: 'webhooks.secret' as const, id };
    expect(await d1.storedSecrets.replace(ref, 'not-what-is-stored', 'x')).toBe(false);
    expect(await d1.storedSecrets.replace(ref, 's1', 's2')).toBe(true);
    expect((await rawSecret(id))?.secret).toBe('s2');

    const href = { column: 'webhooks.headers' as const, id, key: 'K' };
    expect(await d1.storedSecrets.replace(href, 'stale', 'v2')).toBe(false);
    expect(await d1.storedSecrets.replace(href, 'v1', 'v2')).toBe(true);
    // json_set touches only that header.
    expect((await rawSecret(id))?.headers).toEqual({ K: 'v2', Keep: 'kept' });
    await d1.webhooks.delete(scope, id);
  });

  it('reseals previous-key values onto the current key end to end', async () => {
    await oldRow(`${run}-d`, 'whsec_old_key', { H: 'old-key-header' });
    const rotated = createSecretSealer({ current: KEY, previous: OLD });
    const store = { ...d1, storedSecrets: mine(d1.storedSecrets) } as ContentStore;

    const r = await resealSecrets({ store, sealer: rotated });
    // b: secret + 2 headers; d: secret + 1 header.
    expect(r).toMatchObject({ resealed: 5, unreadable: 0, complete: true });

    const prefix = await sealer.currentPrefix();
    for (const id of ['b', 'd'].map((s) => `${run}-${s}`)) {
      const row = await rawSecret(id);
      expect(row?.secret.startsWith(prefix)).toBe(true);
      for (const v of Object.values(row?.headers ?? {})) expect(v.startsWith(prefix)).toBe(true);
    }
    // The new key alone opens everything now.
    const after = withSealedSecrets(d1, sealer);
    expect((await after.webhooks.get(scope, `${run}-d`))?.secret).toBe('whsec_old_key');
    expect((await after.webhooks.get(scope, `${run}-b`))?.headers).toEqual({ A: 'a2', B: 'b2' });
    expect(secretContext.webhookSecret('x')).toBe('webhooks.secret:x');

    expect(await resealSecrets({ store, sealer: rotated })).toMatchObject({
      examined: 0,
      complete: true,
    });
  });
});
