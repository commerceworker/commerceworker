import { decryptSecret, encryptSecret, sealedWithCurrent } from '@commerceworker/core';
import { InMemorySealedSecrets } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { resealSecrets, sealContext } from '../src/commerce';

const OLD = 'old-data-key';
const NEW = 'new-data-key';

describe('resealing secrets at rest', () => {
  it('moves values onto the current key, seals plain ones, and counts what neither key opens', async () => {
    const hookCtx = sealContext('webhook_subscriptions.secret', 'hook_1');
    const pluginCtx = sealContext('plugin_secrets.value', 'shop/API_KEY');
    const underOld = await encryptSecret([OLD], 'whsec_old', hookCtx);
    const underNew = await encryptSecret([NEW], 'pk_new', pluginCtx);
    const secrets = new InMemorySealedSecrets({
      'webhook_subscriptions.secret': { hook_1: underOld },
      'plugin_secrets.value': { 'shop/API_KEY': underNew },
      'integrations.secret': { int_1: 'stored before encryption' },
      'users.totp_secret': { usr_1: await encryptSecret(['some-other-key'], 'x', 'c') },
    });
    expect(await resealSecrets({ secrets }, [NEW, OLD])).toEqual({ resealed: 2, unreadable: 1 });
    const [hook] = await secrets.values('webhook_subscriptions.secret');
    expect(await sealedWithCurrent([NEW, OLD], hook!.value)).toBe(true);
    expect(await decryptSecret([NEW], hook!.value, hookCtx)).toBe('whsec_old');
    const [integration] = await secrets.values('integrations.secret');
    expect(
      await decryptSecret([NEW], integration!.value, sealContext('integrations.secret', 'int_1')),
    ).toBe('stored before encryption');
    // Already on the current key: left as it was.
    expect((await secrets.values('plugin_secrets.value'))[0]?.value).toBe(underNew);
    expect(await resealSecrets({ secrets }, [NEW, OLD])).toEqual({ resealed: 0, unreadable: 1 });
  });

  it('does nothing without a current key', async () => {
    const secrets = new InMemorySealedSecrets({ 'integrations.secret': { int_1: 'plain' } });
    expect(await resealSecrets({ secrets }, [undefined, OLD])).toEqual({
      resealed: 0,
      unreadable: 0,
    });
  });
});
