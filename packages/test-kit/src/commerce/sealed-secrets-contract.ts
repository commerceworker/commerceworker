/**
 * The behaviour every `SealedSecretStore` keeps: the in-memory store runs it in node and the D1
 * store in workerd (packages/db). Ids start `ss_`.
 */
import type { SealedSecretStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { SealedFixture } from './sealed-secrets';

export const SEALED_FIXTURE: SealedFixture = {
  'users.totp_secret': { ss_user: 'totp-1', ss_user_no2fa: null },
  'webhook_subscriptions.secret': { ss_hook: 'hook-1' },
  'webhook_subscriptions.previous_secret': { ss_hook: 'hook-0' },
  'integrations.secret': { ss_int: 'int-1' },
  'plugin_secrets.value': { 'ss_plugin/API_KEY': 'plug-1' },
};

export function describeSealedSecretsContract(
  name: string,
  make: (fixture: SealedFixture) => Promise<SealedSecretStore>,
) {
  describe(`${name}: the sealed secrets contract`, () => {
    const mine = <T extends { id: string }>(xs: T[]) => xs.filter((x) => x.id.startsWith('ss_'));

    it('reads every stored value of a column, leaving out empty ones', async () => {
      const s = await make(SEALED_FIXTURE);
      expect(mine(await s.values('users.totp_secret'))).toEqual([
        { column: 'users.totp_secret', id: 'ss_user', value: 'totp-1' },
      ]);
      expect(
        mine(await s.values('webhook_subscriptions.previous_secret')).map((v) => v.value),
      ).toEqual(['hook-0']);
      expect(mine(await s.values('integrations.previous_secret'))).toEqual([]);
      expect(mine(await s.values('plugin_secrets.value'))).toEqual([
        { column: 'plugin_secrets.value', id: 'ss_plugin/API_KEY', value: 'plug-1' },
      ]);
    });

    it('replaces a value only while it is still the one read', async () => {
      const s = await make(SEALED_FIXTURE);
      expect(await s.replace('webhook_subscriptions.secret', 'ss_hook', 'hook-1', 'hook-2')).toBe(
        true,
      );
      expect(await s.replace('webhook_subscriptions.secret', 'ss_hook', 'hook-1', 'hook-3')).toBe(
        false,
      );
      expect(mine(await s.values('webhook_subscriptions.secret'))[0]?.value).toBe('hook-2');
      expect(await s.replace('plugin_secrets.value', 'ss_plugin/API_KEY', 'plug-1', 'plug-2')).toBe(
        true,
      );
      expect(mine(await s.values('plugin_secrets.value'))[0]?.value).toBe('plug-2');
      // The previous secret is its own column: the current one's change didn't touch it.
      expect(mine(await s.values('webhook_subscriptions.previous_secret'))[0]?.value).toBe(
        'hook-0',
      );
    });
  });
}
