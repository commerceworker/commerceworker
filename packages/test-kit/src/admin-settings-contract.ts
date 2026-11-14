import type { AdminSettings } from '@commerceworker/ports';
import { describe, expect, it } from 'vitest';

export function describeAdminSettingsContract(name: string, make: () => Promise<AdminSettings>) {
  const row = (value: string, key = 'asc_setup') => ({
    key,
    value,
    updatedAt: 100,
    updatedBy: 'admin',
  });
  describe(`${name}: admin settings`, () => {
    it('reads and updates only the named setting', async () => {
      const s = await make();
      expect(await s.get('asc_missing')).toBeUndefined();
      await s.set(row('admin', 'asc_two_factor'));
      await s.set(row('on', 'asc_sso'));
      await s.set(row('off', 'asc_two_factor'));
      expect(await s.get('asc_two_factor')).toBe('off');
      expect(await s.get('asc_sso')).toBe('on');
    });
    it('reads setting metadata and removes only the named setting', async () => {
      const s = await make();
      await s.set(row('hash', 'asc_token'));
      await s.set(row('map', 'asc_roles'));
      expect(await s.record('asc_token')).toEqual(row('hash', 'asc_token'));
      await s.remove('asc_token');
      await s.remove('asc_token');
      expect(await s.record('asc_token')).toBeUndefined();
      expect(await s.get('asc_roles')).toBe('map');
    });
    it('admits exactly one simultaneous claim of the same code and permits rotation', async () => {
      const s = await make();
      const results = await Promise.all([s.claim(row('one')), s.claim(row('one'))]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await s.claim(row('one'))).toBe(false);
      expect(await s.claim(row('two'))).toBe(true);
      expect(await s.get('asc_setup')).toBe('two');
    });
    it('returns a failed first claim or restores the previous code', async () => {
      const s = await make();
      await s.claim(row('one'));
      await s.release('asc_setup', 'one', undefined);
      expect(await s.get('asc_setup')).toBeUndefined();
      await s.claim(row('one'));
      await s.claim(row('two'));
      await s.release('asc_setup', 'two', 'one');
      expect(await s.get('asc_setup')).toBe('one');
    });
    it('never returns a claim that has since been replaced', async () => {
      const s = await make();
      await s.claim(row('one'));
      await s.claim(row('two'));
      await s.release('asc_setup', 'one', undefined);
      expect(await s.get('asc_setup')).toBe('two');
      await s.release('asc_setup', 'one', 'old');
      expect(await s.get('asc_setup')).toBe('two');
    });
  });
}
