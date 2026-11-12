/**
 * The behaviour every `UcpStore` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). Platform ids start `ucs_`.
 */
import type { UcpStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { UcpFixture } from './ucp-store';

export const UCP_FIXTURE: UcpFixture = {
  platforms: [
    { id: 'ucs_shop' },
    { id: 'ucs_gone', profile: '{"a":1}', profileFetchedAt: 1, revokedAt: 2 },
  ],
};

export function describeUcpStoreContract(
  name: string,
  make: (fixture: UcpFixture) => Promise<UcpStore>,
) {
  describe(`${name}: the UCP store contract`, () => {
    it('claims a key once per platform, holds its response, and frees it', async () => {
      const s = await make(UCP_FIXTURE);
      expect(await s.claimKey('ucs_shop', 'k1', 'h1', 100, 0)).toBe(true);
      expect(await s.claimKey('ucs_shop', 'k1', 'h2', 101, 0)).toBe(false);
      expect(await s.claimKey('ucs_other', 'k1', 'h1', 100, 0)).toBe(true);
      expect(await s.heldKey('ucs_shop', 'k1')).toEqual({
        requestHash: 'h1',
        status: null,
        response: null,
      });
      await s.settleKey('ucs_shop', 'k1', 201, '{"id":"chk_1"}');
      expect(await s.heldKey('ucs_shop', 'k1')).toEqual({
        requestHash: 'h1',
        status: 201,
        response: '{"id":"chk_1"}',
      });
      await s.releaseKey('ucs_shop', 'k1');
      expect(await s.heldKey('ucs_shop', 'k1')).toBeUndefined();
    });

    it('frees a key claimed before the stale time', async () => {
      const s = await make(UCP_FIXTURE);
      await s.claimKey('ucs_shop', 'k2', 'h1', 100, 0);
      expect(await s.claimKey('ucs_shop', 'k2', 'h2', 500, 200)).toBe(true);
      expect((await s.heldKey('ucs_shop', 'k2'))?.requestHash).toBe('h2');
    });

    it("reads and caches a platform's profile", async () => {
      const s = await make(UCP_FIXTURE);
      expect(await s.platform('ucs_shop')).toEqual({
        profile: null,
        profileFetchedAt: null,
        revokedAt: null,
      });
      await s.cacheProfile('ucs_shop', '{"b":2}', 9);
      expect(await s.platform('ucs_shop')).toEqual({
        profile: '{"b":2}',
        profileFetchedAt: 9,
        revokedAt: null,
      });
      expect((await s.platform('ucs_gone'))?.revokedAt).toBe(2);
      expect(await s.platform('ucs_none')).toBeUndefined();
    });

    it('lets a platform in with a key, finds it by the key until revoked, once', async () => {
      const s = await make({
        platforms: [
          { id: 'ucs_old', createdAt: 1 },
          { id: 'ucs_gone', createdAt: 2, revokedAt: 3 },
        ],
      });
      await s.addPlatform({
        id: 'ucs_new',
        name: 'Shopping agent',
        profileUrl: 'https://agent.example/.well-known/ucp',
        keyPrefix: 'cmw_ucp_ab',
        keyHash: 'ucs_hash_new',
        redirectUris: ['https://agent.example/cb', 'https://agent.example/other'],
        createdAt: 10,
        createdBy: 'ada@example.com',
      });
      const listed = (await s.platforms(10)).filter((p) => p.id.startsWith('ucs_'));
      expect(listed.map((p) => p.id)).toEqual(['ucs_new', 'ucs_gone', 'ucs_old']);
      expect(listed[0]).toEqual({
        id: 'ucs_new',
        name: 'Shopping agent',
        profileUrl: 'https://agent.example/.well-known/ucp',
        keyPrefix: 'cmw_ucp_ab',
        redirectUris: ['https://agent.example/cb', 'https://agent.example/other'],
        createdAt: 10,
        createdBy: 'ada@example.com',
        lastUsedAt: null,
        revokedAt: null,
      });
      // A platform registered with none lists none, and is found the same ways.
      expect(listed[2]!.redirectUris).toEqual([]);
      expect((await s.livePlatformById('ucs_new'))?.redirectUris).toEqual([
        'https://agent.example/cb',
        'https://agent.example/other',
      ]);
      expect((await s.livePlatform('ucs_hash_new'))?.redirectUris).toHaveLength(2);
      expect((await s.livePlatform('ucs_hash_new'))?.id).toBe('ucs_new');
      expect(await s.livePlatform('ucs_gone')).toBeUndefined();
      expect((await s.livePlatformById('ucs_new'))?.id).toBe('ucs_new');
      expect(await s.livePlatformById('ucs_gone')).toBeUndefined();
      await s.touchPlatform('ucs_new', 20);
      expect((await s.livePlatform('ucs_hash_new'))?.lastUsedAt).toBe(20);
      expect(await s.revokePlatform('ucs_new', 30)).toMatchObject({ id: 'ucs_new', revokedAt: 30 });
      expect(await s.revokePlatform('ucs_new', 40)).toBeUndefined();
      expect(await s.revokePlatform('ucs_none', 40)).toBeUndefined();
      expect(await s.livePlatform('ucs_hash_new')).toBeUndefined();
      expect(await s.livePlatformById('ucs_new')).toBeUndefined();
      // Revoked, it is still listed: its checkouts and orders name it.
      expect((await s.platforms(10)).some((p) => p.id === 'ucs_new')).toBe(true);
    });
  });
}
