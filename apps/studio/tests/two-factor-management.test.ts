import { InMemoryAdminAuth } from '@commerceworker/test-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromBase32, hashRecoveryCode, newTotpSecret, totpCode, totpStep } from '~/lib/totp';

let store: InMemoryAdminAuth;
const audit = vi.fn();
const reauthenticate = vi.fn();
const endAccess = vi.fn();
let required = 'off';
vi.mock('~/lib/wire.server', () => ({ adminAuth: () => store }));
vi.mock('~/lib/auth.server', () => ({ reauthenticate }));
vi.mock('~/lib/audit.server', () => ({ audit }));
vi.mock('~/lib/data-key.server', () => ({
  sealSecret: async (secret: string) => `sealed:${secret}`,
}));
vi.mock('~/lib/settings.server', () => ({ twoFactorRequirement: async () => required }));
vi.mock('~/lib/team.server', () => ({ TeamError: class extends Error {} }));
vi.mock('~/lib/access.server', () => ({
  endAccess,
  endedDetail: (ended: Record<string, number>) =>
    Object.fromEntries(Object.entries(ended).filter(([, n]) => n > 0)),
}));
const {
  twoFactorStatus,
  enableTwoFactor,
  disableTwoFactor,
  regenerateRecoveryCodes,
  resetTwoFactor,
} = await import('~/lib/two-factor.server');
const by = {
  kind: 'user' as const,
  id: 'ada',
  email: 'ada@example.com',
  name: 'Ada',
  role: 'admin' as const,
};
const other = { id: 'ann', email: 'ann@example.com', name: 'Ann', role: 'member' };
const request = new Request('https://studio.example.com/account', { method: 'POST' });
const input = async () => {
  const secret = newTotpSecret();
  return {
    secret,
    code: await totpCode(fromBase32(secret)!, totpStep(Date.now())),
    password: 'correct',
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
  store = new InMemoryAdminAuth({ users: [{ ...by, passwordHash: 'password-hash' }, other] });
  audit.mockReset();
  reauthenticate.mockReset().mockResolvedValue(true);
  endAccess.mockReset().mockResolvedValue({ sessions: 2, passkeys: 1, tokens: 3 });
  required = 'off';
});
afterEach(() => vi.useRealTimers());

describe('two-factor management over the auth port', () => {
  it('reports the stored state and admits no open-local-development account', async () => {
    expect(await twoFactorStatus(by)).toEqual({ enabledAt: null, recoveryLeft: 0 });
    expect(
      await twoFactorStatus({ kind: 'open', id: 'local', name: 'local', role: 'admin' }),
    ).toBeNull();
  });
  it('enables from a confirmed code, seals the secret and stores only recovery-code hashes', async () => {
    const given = await input();
    const codes = await enableTwoFactor(request, by, given);
    expect(reauthenticate).toHaveBeenCalledWith(by.id, 'correct', 'password-hash');
    expect(await store.user(by.id)).toMatchObject({
      totpSecret: `sealed:${given.secret}`,
      totpLastStep: totpStep(Date.now()),
    });
    expect(await twoFactorStatus(by)).toEqual({
      enabledAt: Date.now(),
      recoveryLeft: codes.length,
    });
    expect(await store.useTotpStep(by.id, totpStep(Date.now()))).toBe(false);
    expect(await store.useRecoveryCode(by.id, codes[0]!)).toBe(false);
    expect(await store.useRecoveryCode(by.id, await hashRecoveryCode(codes[0]!))).toBe(true);
    expect(audit).toHaveBeenCalledWith(request, 'auth.two_factor_enabled', {
      actor: by,
      target: by.email,
    });
  });
  it('refuses a wrong password before changing credentials', async () => {
    reauthenticate.mockResolvedValue(false);
    await expect(enableTwoFactor(request, by, await input())).rejects.toThrow(/password/);
    expect(await twoFactorStatus(by)).toEqual({ enabledAt: null, recoveryLeft: 0 });
    expect(audit).not.toHaveBeenCalled();
  });
  it('refuses malformed secrets and nonmatching codes before writing', async () => {
    const given = await input();
    await expect(enableTwoFactor(request, by, { ...given, secret: 'invalid' })).rejects.toThrow(
      /setup again/,
    );
    await expect(enableTwoFactor(request, by, { ...given, code: 'invalid' })).rejects.toThrow(
      /doesn’t match/,
    );
    expect(await twoFactorStatus(by)).toEqual({ enabledAt: null, recoveryLeft: 0 });
  });
  it('refuses replacing an already enabled authenticator through setup', async () => {
    await enableTwoFactor(request, by, await input());
    await expect(enableTwoFactor(request, by, await input())).rejects.toThrow(/already on/);
  });
  it('regenerates recovery codes and revokes all the old ones', async () => {
    await expect(regenerateRecoveryCodes(request, by, 'correct')).rejects.toThrow(/Turn on/);
    const old = await enableTwoFactor(request, by, await input());
    const codes = await regenerateRecoveryCodes(request, by, 'correct');
    for (const code of old)
      expect(await store.useRecoveryCode(by.id, await hashRecoveryCode(code))).toBe(false);
    expect(await store.recoveryCodesLeft(by.id)).toBe(codes.length);
    expect(audit).toHaveBeenLastCalledWith(request, 'auth.recovery_codes_replaced', {
      actor: by,
      target: by.email,
    });
  });
  it('keeps two-factor on when the role requires it', async () => {
    await enableTwoFactor(request, by, await input());
    required = 'admin';
    await expect(disableTwoFactor(request, by, 'correct')).rejects.toThrow(/can’t be turned off/);
    expect((await twoFactorStatus(by))?.enabledAt).not.toBeNull();
  });
  it('disables the secret and recovery codes together and audits once', async () => {
    await enableTwoFactor(request, by, await input());
    audit.mockClear();
    await disableTwoFactor(request, by, 'correct');
    await disableTwoFactor(request, by, 'correct');
    expect(await twoFactorStatus(by)).toEqual({ enabledAt: null, recoveryLeft: 0 });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(request, 'auth.two_factor_disabled', {
      actor: by,
      target: by.email,
    });
  });
  it('resets another person only after ending their access, and audits the counts', async () => {
    await store.enableTotp(other.id, 'sealed', 1, 1);
    await store.replaceRecoveryCodes(other.id, ['code']);
    await resetTwoFactor(request, by, other.id);
    expect(endAccess).toHaveBeenCalledWith(
      request,
      { id: other.id, email: other.email },
      { sessions: true, passkeys: true, tokens: true },
    );
    expect(await store.recoveryCodesLeft(other.id)).toBe(0);
    expect(audit).toHaveBeenCalledWith(request, 'team.two_factor_reset', {
      actor: by,
      target: other.email,
      detail: { sessions: 2, passkeys: 'removed', tokens: 3 },
    });
  });
  it('refuses self-reset and unknown people, and preserves credentials if access revocation fails', async () => {
    await expect(resetTwoFactor(request, by, by.id)).rejects.toThrow(/your own/);
    await expect(resetTwoFactor(request, by, 'missing')).rejects.toThrow(/no longer/);
    await store.enableTotp(other.id, 'sealed', 1, 1);
    endAccess.mockRejectedValueOnce(new Error('API unavailable'));
    await expect(resetTwoFactor(request, by, other.id)).rejects.toThrow(/API unavailable/);
    expect((await store.user(other.id))?.totpEnabledAt).toBe(1);
    expect(audit).not.toHaveBeenCalled();
  });
});
