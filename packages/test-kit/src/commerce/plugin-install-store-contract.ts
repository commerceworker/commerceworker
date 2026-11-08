/**
 * The behaviour every `PluginInstallStore` keeps: the in-memory store runs it in node and the D1
 * store in workerd (packages/db). Plugin ids start `pi_`.
 */
import type { PluginInstallRecord, PluginInstallStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const row = (
  id: string,
  sha: string,
  version: string,
  over: Partial<PluginInstallRecord> = {},
) => ({
  id,
  sha,
  version,
  publisher: 'acme',
  manifest: '{}',
  status: 'pending',
  personalDataGranted: 0,
  uploadedBy: 'ada@example.com',
  uploadedAt: 1,
  approvedBy: null,
  approvedAt: null,
  request: null,
  cases: null,
  ...over,
});

export function describePluginInstallStoreContract(
  name: string,
  make: () => Promise<PluginInstallStore>,
) {
  describe(`${name}: the plugin install store contract`, () => {
    it('uploads a version once, refusing a second file of the same version', async () => {
      const s = await make();
      expect(await s.upload(row('pi_a', 'sha1', '1.0.0'))).toBe('ok');
      expect(await s.upload(row('pi_a', 'sha2', '1.0.0'))).toBe('conflict');
      expect((await s.versions('pi_a')).map((r) => [r.sha, r.status])).toEqual([
        ['sha1', 'pending'],
      ]);
    });

    it('activates one version at a time, superseding the one that ran', async () => {
      const s = await make();
      await s.upload(row('pi_b', 'sha1', '1.0.0'));
      await s.upload(row('pi_b', 'sha2', '2.0.0'));
      expect(await s.activate({ id: 'pi_b', sha: 'sha1' }, 'pending', { approvedBy: 'ada' })).toBe(
        true,
      );
      expect(await s.activeSha('pi_b')).toBe('sha1');
      expect(
        await s.activate({ id: 'pi_b', sha: 'sha2' }, 'pending', { personalDataGranted: 1 }),
      ).toBe(true);
      expect(await s.activeSha('pi_b')).toBe('sha2');
      const byStatus = Object.fromEntries((await s.versions('pi_b')).map((r) => [r.sha, r.status]));
      expect(byStatus).toEqual({ sha1: 'superseded', sha2: 'active' });
      expect((await s.active()).filter((a) => a.id === 'pi_b')).toEqual([
        { id: 'pi_b', sha: 'sha2', personalData: true, publisher: 'acme' },
      ]);
      // Rolling back: the earlier one runs again.
      expect(await s.activate({ id: 'pi_b', sha: 'sha1' }, 'superseded', {})).toBe(true);
      expect(await s.activate({ id: 'pi_b', sha: 'sha1' }, 'superseded', {})).toBe(false);
      expect(await s.activeSha('pi_b')).toBe('sha1');
    });

    it('disables and re-enables only from the status it expects', async () => {
      const s = await make();
      await s.upload(row('pi_c', 'sha1', '1.0.0'));
      await s.activate({ id: 'pi_c', sha: 'sha1' }, 'pending', {});
      expect(await s.setStatus('pi_c', 'sha1', 'active', 'disabled')).toBe(true);
      expect(await s.setStatus('pi_c', 'sha1', 'active', 'disabled')).toBe(false);
      expect(await s.activeSha('pi_c')).toBeUndefined();
      expect(await s.setStatus('pi_c', 'sha1', 'disabled', 'active')).toBe(true);
    });

    it("replaces a draft's cases only over the ones it read", async () => {
      const s = await make();
      await s.upload(row('pi_d', 'sha1', '1.0.0'));
      expect(await s.setCases('pi_d', 'sha1', null, '[1]')).toBe(true);
      expect(await s.setCases('pi_d', 'sha1', null, '[2]')).toBe(false);
      expect(await s.setCases('pi_d', 'sha1', '[1]', '[2]')).toBe(true);
      expect((await s.versions('pi_d'))[0]?.cases).toBe('[2]');
    });

    it('keeps sealed secrets until uninstalled, then lets the same file upload again', async () => {
      const s = await make();
      await s.upload(row('pi_e', 'sha1', '1.0.0'));
      await s.setSecret('pi_e', 'API_KEY', 'sealed-1', 'ada');
      await s.setSecret('pi_e', 'API_KEY', 'sealed-2', 'ada');
      expect(await s.secret('pi_e', 'API_KEY')).toBe('sealed-2');
      await s.uninstall('pi_e');
      expect(await s.secret('pi_e', 'API_KEY')).toBeUndefined();
      expect((await s.versions('pi_e'))[0]?.status).toBe('uninstalled');
      expect(await s.upload(row('pi_e', 'sha1', '1.0.0', { uploadedBy: 'grace' }))).toBe('ok');
      expect((await s.versions('pi_e'))[0]).toMatchObject({
        status: 'pending',
        uploadedBy: 'grace',
      });
    });

    it('records errors, keeping only the latest', async () => {
      const s = await make();
      await s.recordErrors(
        'pi_f',
        [
          { message: 'a', at: 1 },
          { message: 'b', at: 2 },
        ],
        2,
      );
      await s.recordErrors('pi_f', [{ message: 'c', at: 3 }], 2);
      await s.recordErrors('pi_f', [], 2);
      // Newest first, the oldest dropped past `keep`.
      expect((await s.errors('pi_f', 10)).map((e) => [e.message, e.at])).toEqual([
        ['c', 3],
        ['b', 2],
      ]);
      expect((await s.errors('pi_f', 1)).map((e) => e.message)).toEqual(['c']);
      expect(await s.errors('pi_none', 10)).toEqual([]);
    });
  });
}
