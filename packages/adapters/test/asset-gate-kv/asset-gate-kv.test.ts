import { describe, expect, it } from 'vitest';
import {
  assetGateKey,
  createKvAssetGate,
  GATE_READ_TTL_SECONDS,
  type KvGateBinding,
} from '../../src/asset-gate-kv/index';

function fakeKv() {
  const values = new Map<string, string>();
  const reads: { key: string; cacheTtl?: number }[] = [];
  const kv: KvGateBinding = {
    async get(key, options) {
      reads.push({ key, ...(options?.cacheTtl ? { cacheTtl: options.cacheTtl } : {}) });
      return values.get(key) ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    // Two keys a page, so a scope's removal has to follow the cursor (which, as KV's, resumes
    // after the page's last key, whatever was deleted meanwhile).
    async list({ prefix, cursor }) {
      const rest = [...values.keys()]
        .filter((k) => k.startsWith(prefix) && (!cursor || k > cursor))
        .sort();
      const keys = rest.slice(0, 2).map((name) => ({ name }));
      const done = rest.length <= 2;
      return { keys, list_complete: done, ...(done ? {} : { cursor: keys.at(-1)?.name }) };
    },
  };
  return { kv, values, reads };
}

const scope = { spaceId: 'shop', environmentId: 'main' };
const entry = { v: 2, r2Key: 'shop/main/a/x.png', contentType: 'image/png', fileName: 'x.png' };

describe('the KV asset gate', () => {
  it('keeps one entry per published asset under its scope', async () => {
    const { kv, values, reads } = fakeKv();
    const gate = createKvAssetGate(kv);
    await gate.put(scope, 'a', { ...entry, focal: { x: 0.5, y: 0.5 } });
    expect([...values.keys()]).toEqual([assetGateKey(scope, 'a')]);
    expect(assetGateKey(scope, 'a')).toBe('asset-gate:shop:main:a');
    expect(await gate.get(scope, 'a')).toEqual({ ...entry, focal: { x: 0.5, y: 0.5 } });
    // Reads use KV's edge cache for the minimum the engine's second purge waits out.
    expect(reads.at(-1)?.cacheTtl).toBe(GATE_READ_TTL_SECONDS);
    expect(await gate.get({ ...scope, environmentId: 'staging' }, 'a')).toBeNull();
    await gate.delete(scope, 'a');
    expect(await gate.get(scope, 'a')).toBeNull();
  });

  it('removes a whole environment’s entries, page by page, and nothing of any other', async () => {
    const { kv, values } = fakeKv();
    const gate = createKvAssetGate(kv);
    for (const id of ['a', 'b', 'c', 'd', 'e']) await gate.put(scope, id, entry);
    // `main:x` shares the prefix `asset-gate:shop:main:`; its entries must stay.
    const colon = { spaceId: 'shop', environmentId: 'main:x' };
    await gate.put(colon, 'a', entry);
    await gate.put({ ...scope, environmentId: 'staging' }, 'a', entry);
    await gate.put({ spaceId: 'shop2', environmentId: 'main' }, 'a', entry);

    await gate.deleteScope(scope);

    expect([...values.keys()].sort()).toEqual(
      [
        assetGateKey(colon, 'a'),
        assetGateKey({ ...scope, environmentId: 'staging' }, 'a'),
        assetGateKey({ spaceId: 'shop2', environmentId: 'main' }, 'a'),
      ].sort(),
    );
    // Again (a redelivered event): nothing left, nothing else touched.
    await gate.deleteScope(scope);
    expect(values.size).toBe(3);
  });

  it('gates nothing for an entry it can’t read', async () => {
    const { kv, values } = fakeKv();
    values.set(assetGateKey(scope, 'a'), 'not json');
    values.set(assetGateKey(scope, 'b'), JSON.stringify({ v: 'one' }));
    const gate = createKvAssetGate(kv);
    expect(await gate.get(scope, 'a')).toBeNull();
    expect(await gate.get(scope, 'b')).toBeNull();
  });
});
