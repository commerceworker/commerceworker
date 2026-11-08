import { DEV_DATA_KEY } from '@commerceworker/application';
import { SecretUnreadableError } from '@commerceworker/domain';
import { dataKeysFromEnv, isResealTick, sealerFromEnv } from '@commerceworker/platform/data-key';
import type { EdgeEnv } from '@commerceworker/platform/env';
import { describe, expect, it } from 'vitest';
import { toHttpError } from '../../src/api/http';

const env = (vars: Record<string, string>) => vars as unknown as EdgeEnv;
const STRONG = 'k'.repeat(44);

describe('DATA_KEY boot guard', () => {
  it('refuses a persistent deployment without DATA_KEY', () => {
    expect(() => dataKeysFromEnv(env({}), true)).toThrow(/DATA_KEY is unset/);
    expect(() => dataKeysFromEnv(env({ REQUIRE_SECURE_SECRETS: 'true' }), true)).toThrow(
      /Refusing to start/,
    );
  });

  it('refuses a short or dev DATA_KEY where secure secrets are required', () => {
    expect(() => dataKeysFromEnv(env({ DATA_KEY: 'short' }), true)).toThrow(/at least 32/);
    expect(() => dataKeysFromEnv(env({ DATA_KEY: DEV_DATA_KEY }), true)).toThrow(/dev key/);
  });

  it('refuses DATA_KEY_PREVIOUS equal to DATA_KEY', () => {
    expect(() =>
      dataKeysFromEnv(env({ DATA_KEY: STRONG, DATA_KEY_PREVIOUS: STRONG }), true),
    ).toThrow(/must differ/);
  });

  it('accepts a strong key, with the previous key during a rotation', () => {
    expect(
      dataKeysFromEnv(env({ DATA_KEY: STRONG, DATA_KEY_PREVIOUS: 'p'.repeat(44) }), true),
    ).toEqual({ current: STRONG, previous: 'p'.repeat(44) });
  });

  it('falls back to the fixed dev key on persistent dev (REQUIRE_SECURE_SECRETS=false)', () => {
    expect(dataKeysFromEnv(env({ REQUIRE_SECURE_SECRETS: 'false' }), true)).toEqual({
      current: DEV_DATA_KEY,
    });
  });

  it('generates one key per isolate for the in-memory store', async () => {
    const a = dataKeysFromEnv(env({}), false);
    const b = dataKeysFromEnv(env({}), false);
    expect(a.current).toBe(b.current);
    expect(a.current).not.toBe(DEV_DATA_KEY);
    const sealer = sealerFromEnv(env({}), false);
    expect(await sealer.open(await sealer.seal('s', 'c'), 'c')).toBe('s');
  });
});

describe('reseal schedule', () => {
  it('fires once a day, on the 03:30 UTC tick', () => {
    expect(isResealTick(Date.UTC(2026, 0, 1, 3, 30))).toBe(true);
    expect(isResealTick(Date.UTC(2026, 0, 1, 3, 31))).toBe(false);
    expect(isResealTick(Date.UTC(2026, 0, 1, 4, 30))).toBe(false);
  });
});

describe('unreadable secrets over HTTP', () => {
  it('maps to 500 and names only where the value lives', () => {
    const { status, body } = toHttpError(new SecretUnreadableError('webhooks.secret:w1'));
    expect(status).toBe(500);
    expect(JSON.stringify(body)).toContain('secret_unreadable');
  });
});
