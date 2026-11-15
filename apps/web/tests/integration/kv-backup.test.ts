import { introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  type KvManifest,
  kvChunkKey,
  kvManifestKey,
  loadKvChunk,
  planKvRestore,
  readKvManifest,
} from '@commerceworker/application/commerce';
import { BackupRefusal } from '@commerceworker/ports/commerce';
import { beforeEach, describe, expect, it } from 'vitest';

const today = new Date().toISOString().slice(0, 10);
const FAR = Math.floor(Date.now() / 1000) + 30 * 86_400;

async function ended(id: string) {
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    const s = await (await env.KV_BACKUP.get(id)).status();
    if (['errored', 'complete', 'terminated'].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${id} did not end`);
}

async function emptyBucket() {
  for (;;) {
    const page = await env.BACKUPS.list();
    if (!page.objects.length) return;
    await env.BACKUPS.delete(page.objects.map((o) => o.key));
  }
}

/** A namespace like the provider's: clients and grants (some expiring, with metadata), and a device record that must not be copied. */
async function seed(grants: number) {
  for (;;) {
    const page = await env.OAUTH_KV.list();
    if (!page.keys.length) break;
    await Promise.all(page.keys.map((k) => env.OAUTH_KV.delete(k.name)));
  }
  await env.OAUTH_KV.put('client:app-1', JSON.stringify({ clientId: 'app-1' }));
  await env.OAUTH_KV.put('cmw_device_client:app-1', '1', { metadata: { kind: 'device' } });
  await env.OAUTH_KV.put('cmw_device:abc', JSON.stringify({ origin: { ip: '203.0.113.7' } }), {
    expirationTtl: 600,
  });
  await env.OAUTH_KV.put('transaction:t1', 'sealed', { expirationTtl: 600 });
  for (let i = 0; i < grants; i++)
    await env.OAUTH_KV.put(`grant:usr_1:g${String(i).padStart(5, '0')}`, `{"n":${i}}`, {
      expiration: FAR + i,
      metadata: { app: `app-${i}` },
    });
}

beforeEach(emptyBucket);

describe('the nightly OAuth grant export', () => {
  it('copies every key with its metadata and expiration, and writes the manifest last', async () => {
    // Past one page of 1,000 keys: two chunks.
    await seed(1_200);
    await env.KV_BACKUP.create({ id: 'kvb-1' });
    const s = await ended('kvb-1');
    expect(s.status, JSON.stringify(s.error)).toBe('complete');

    const manifest = (await readKvManifest(env.BACKUPS, today, 'oauth')) as KvManifest;
    // 1,200 grants and the two registered-client keys; the device record and the transaction are left out.
    expect(manifest.keys).toBe(1_202);
    expect(manifest.skipped).toEqual({ ephemeral: 2, vanished: 0 });
    expect(manifest.capped).toBe(false);
    expect(manifest.chunks.map((c) => c.key)).toEqual([
      kvChunkKey(today, 'oauth', 0),
      kvChunkKey(today, 'oauth', 1),
    ]);
    expect(s.output).toMatchObject({ date: today, keys: 1_202, chunks: 2 });

    const manifestAt = (await env.BACKUPS.head(kvManifestKey(today, 'oauth')))!.uploaded.getTime();
    const entries = [];
    for (const chunk of manifest.chunks) {
      const head = (await env.BACKUPS.head(chunk.key))!;
      expect(head.customMetadata?.sha256).toBe(chunk.sha256);
      expect(head.uploaded.getTime()).toBeLessThanOrEqual(manifestAt);
      entries.push(...(await loadKvChunk(env.BACKUPS, chunk)));
    }
    const byKey = new Map(entries.map((e) => [e.key, e]));
    expect(byKey.has('cmw_device:abc')).toBe(false);
    expect(byKey.has('transaction:t1')).toBe(false);
    // The registered device client is kept: its prefix is not the sign-in state's.
    expect(byKey.get('cmw_device_client:app-1')).toEqual({
      key: 'cmw_device_client:app-1',
      value: '1',
      metadata: { kind: 'device' },
    });
    // A key that lasts has no expiration; a grant keeps its expiration and its metadata.
    expect(byKey.get('client:app-1')).toEqual({
      key: 'client:app-1',
      value: '{"clientId":"app-1"}',
    });
    expect(byKey.get('grant:usr_1:g00007')).toEqual({
      key: 'grant:usr_1:g00007',
      value: '{"n":7}',
      expiration: FAR + 7,
      metadata: { app: 'app-7' },
    });

    // A restore of the dump a day later keeps the time each grant had left.
    const later = (FAR - 86_400) * 1000;
    const plan = planKvRestore(entries, later);
    expect(plan.expired).toBe(0);
    expect(plan.puts.find((p) => p.key === 'grant:usr_1:g00007')?.expiration_ttl).toBe(86_407);
  });

  it('finds a finished day done, and does nothing a second time', async () => {
    await seed(3);
    await env.KV_BACKUP.create({ id: 'kvb-2a' });
    expect((await ended('kvb-2a')).status).toBe('complete');
    await env.KV_BACKUP.create({ id: 'kvb-2b' });
    const again = await ended('kvb-2b');
    expect(again.output).toEqual({ date: today, skipped: true });
  });

  it('resumes after an interruption: the chunk already stored is kept, the rest copied', async () => {
    await seed(2_300);
    // The first run dies at its second chunk, every attempt.
    const first = await introspectWorkflowInstance(env.KV_BACKUP, 'kvb-3a');
    await first.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: 'chunk 1' }, new Error('KV unavailable'));
    });
    await env.KV_BACKUP.create({ id: 'kvb-3a' });
    expect((await ended('kvb-3a')).status).toBe('errored');
    // Chunk 0 is stored, and with no manifest the day has not finished.
    const kept = (await env.BACKUPS.head(kvChunkKey(today, 'oauth', 0)))!;
    expect(await env.BACKUPS.head(kvManifestKey(today, 'oauth'))).toBeNull();
    expect(await env.BACKUPS.head(kvChunkKey(today, 'oauth', 1))).toBeNull();
    await first.dispose();

    await env.KV_BACKUP.create({ id: 'kvb-3b' });
    const s = await ended('kvb-3b');
    expect(s.status, JSON.stringify(s.error)).toBe('complete');
    // The stored chunk was not written again, and the manifest counts all of it.
    const after = (await env.BACKUPS.head(kvChunkKey(today, 'oauth', 0)))!;
    expect(after.etag).toBe(kept.etag);
    expect(after.uploaded.getTime()).toBe(kept.uploaded.getTime());
    const manifest = (await readKvManifest(env.BACKUPS, today, 'oauth')) as KvManifest;
    expect(manifest.chunks).toHaveLength(3);
    expect(manifest.keys).toBe(2_302);
    expect(manifest.skipped.ephemeral).toBe(2);
  });

  it('refuses a chunk that no longer matches its hash', async () => {
    await seed(5);
    await env.KV_BACKUP.create({ id: 'kvb-4' });
    expect((await ended('kvb-4')).status).toBe('complete');
    const manifest = (await readKvManifest(env.BACKUPS, today, 'oauth')) as KvManifest;
    const chunk = manifest.chunks[0]!;
    // Replaced behind the lock's back (the test bucket has none).
    await env.BACKUPS.put(chunk.key, 'tampered');
    await expect(loadKvChunk(env.BACKUPS, chunk)).rejects.toBeInstanceOf(BackupRefusal);
  });
});
