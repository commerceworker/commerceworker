import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  encodeKvChunk,
  KV_BULK_KEYS,
  type KvEntry,
  type KvManifest,
  kvChunkKey,
  kvManifestKey,
  planKvRestore,
  splitBulk,
} from '../packages/application/src/commerce/kv-restore.ts';
import { planKvRestoreFromBackup } from './fleet.ts';

// The plan that puts an OAuth grant export back (docs/operations.md, "Restoring OAuth grants"): a
// pure function of the dump and the clock, so a restore keeps each key's remaining lifetime
// whenever it is run.

const NOW = Date.parse('2026-11-12T12:00:00Z');
const nowS = NOW / 1000;

test('a key keeps the time it has left, as expiration_ttl', () => {
  const plan = planKvRestore(
    [
      { key: 'grant:u:1', value: 'v', expiration: nowS + 3600 },
      { key: 'grant:u:2', value: 'w', expiration: nowS + 30 * 86_400 },
    ],
    NOW,
  );
  assert.deepEqual(
    plan.puts.map((p) => [p.key, p.expiration_ttl]),
    [
      ['grant:u:1', 3600],
      ['grant:u:2', 30 * 86_400],
    ],
  );
  assert.equal(plan.expired, 0);
});

test('a key already expired is skipped, one expiring this second too', () => {
  const plan = planKvRestore(
    [
      { key: 'gone', value: 'v', expiration: nowS - 1 },
      { key: 'now', value: 'v', expiration: nowS },
      { key: 'kept', value: 'v', expiration: nowS + 120 },
    ],
    NOW,
  );
  assert.deepEqual(
    plan.puts.map((p) => p.key),
    ['kept'],
  );
  assert.equal(plan.expired, 2);
});

test('a key with under a minute left gets the minimum KV accepts', () => {
  const [put] = planKvRestore([{ key: 'k', value: 'v', expiration: nowS + 5 }], NOW).puts;
  assert.equal(put?.expiration_ttl, 60);
});

test('a key that lasts is written with no expiration, and metadata comes along', () => {
  const plan = planKvRestore(
    [
      { key: 'client:a', value: '{}' },
      { key: 'cmw_device_client:a', value: '1', metadata: { kind: 'device' } },
      { key: 'null-meta', value: 'v', metadata: null },
    ],
    NOW,
  );
  assert.deepEqual(plan.puts, [
    { key: 'client:a', value: '{}' },
    { key: 'cmw_device_client:a', value: '1', metadata: { kind: 'device' } },
    { key: 'null-meta', value: 'v' },
  ]);
});

test('the same dump planned later has less left, and more of it expired', () => {
  const dump: KvEntry[] = [{ key: 'k', value: 'v', expiration: nowS + 600 }];
  assert.equal(planKvRestore(dump, NOW).puts[0]?.expiration_ttl, 600);
  assert.equal(planKvRestore(dump, NOW + 300_000).puts[0]?.expiration_ttl, 300);
  assert.equal(planKvRestore(dump, NOW + 600_000).expired, 1);
});

test('a plan is split into files a bulk put takes', () => {
  const puts = Array.from({ length: KV_BULK_KEYS * 2 + 5 }, (_, i) => ({
    key: `k${i}`,
    value: 'v',
  }));
  const files = splitBulk(puts);
  assert.deepEqual(
    files.map((f) => f.length),
    [KV_BULK_KEYS, KV_BULK_KEYS, 5],
  );
  // By bytes too: values near the request limit go one or two to a file.
  const big = splitBulk(
    [1, 2, 3].map((i) => ({ key: `k${i}`, value: 'x'.repeat(40 * 1024 * 1024) })),
  );
  assert.deepEqual(
    big.map((f) => f.length),
    [2, 1],
  );
  assert.deepEqual(splitBulk([]), []);
});

// The dump as the Workflow writes it: chunks and a manifest, read through an in-memory `get`.
function dump(entries: KvEntry[][], tamper?: (key: string, bytes: Uint8Array) => Uint8Array) {
  const objects = new Map<string, Uint8Array>();
  const chunks = entries.map((es, n) => {
    const bytes = new Uint8Array(gzipSync(encodeKvChunk(es)));
    const key = kvChunkKey('2026-11-11', 'oauth', n);
    objects.set(key, bytes);
    return {
      key,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      keys: es.length,
      bytes: bytes.length,
    };
  });
  const manifest: KvManifest = {
    format: 1,
    date: '2026-11-11',
    name: 'oauth',
    startedAt: '2026-11-11T02:00:00Z',
    finishedAt: '2026-11-11T02:00:05Z',
    keys: entries.flat().length,
    skipped: { ephemeral: 0, vanished: 0 },
    capped: false,
    chunks,
  };
  objects.set(
    kvManifestKey('2026-11-11', 'oauth'),
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  if (tamper) for (const [k, v] of objects) objects.set(k, tamper(k, v));
  return async (key: string) => objects.get(key) ?? null;
}

test('a dump is read, verified and planned as of now', async () => {
  const get = dump([
    [
      { key: 'client:a', value: '{}' },
      { key: 'grant:u:old', value: 'v', expiration: nowS - 10 },
    ],
    [{ key: 'grant:u:new', value: 'v', expiration: nowS + 7200, metadata: { a: 1 } }],
  ]);
  const r = await planKvRestoreFromBackup('2026-11-11', get, NOW);
  assert.deepEqual([r.chunks, r.keys, r.expired, r.capped], [2, 3, 1, false]);
  assert.deepEqual(r.files, [
    [
      { key: 'client:a', value: '{}' },
      { key: 'grant:u:new', value: 'v', expiration_ttl: 7200, metadata: { a: 1 } },
    ],
  ]);
});

test('a dump that did not finish, or was altered, is refused', async () => {
  await assert.rejects(planKvRestoreFromBackup('2026-11-10', dump([[]]), NOW), /no manifest/);
  await assert.rejects(planKvRestoreFromBackup('yesterday', dump([[]]), NOW), /not a date/);
  const tampered = dump([[{ key: 'k', value: 'v' }]], (key, bytes) =>
    key.endsWith('.ndjson.gz') ? new Uint8Array(gzipSync('{"key":"k","value":"forged"}')) : bytes,
  );
  await assert.rejects(
    planKvRestoreFromBackup('2026-11-11', tampered, NOW),
    /does not match its hash/,
  );
  const missing = dump([[{ key: 'k', value: 'v' }]]);
  await assert.rejects(
    planKvRestoreFromBackup(
      '2026-11-11',
      async (k) => (k.endsWith('.ndjson.gz') ? null : missing(k)),
      NOW,
    ),
    /is missing/,
  );
});
