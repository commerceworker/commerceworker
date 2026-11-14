import { InMemoryAdminSettings } from '@commerceworker/test-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, string> = {};
let settings = new InMemoryAdminSettings();
const audit = vi.fn();
vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/wire.server', () => ({ adminSettings: () => settings }));
vi.mock('~/lib/audit.server', () => ({ audit }));
const by = {
  kind: 'user' as const,
  id: 'ada',
  email: 'ada@example.com',
  name: 'Ada',
  role: 'admin' as const,
};
const request = new Request('https://studio.example.com/team', { method: 'POST' });

describe('Studio auth settings', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    settings = new InMemoryAdminSettings();
    audit.mockReset();
    for (const key of Object.keys(env)) delete env[key];
  });
  afterEach(() => vi.useRealTimers());

  it('requires two-factor for admins by default and audits a changed requirement once', async () => {
    const { twoFactorRequirement, setTwoFactorRequirement } = await import('~/lib/settings.server');
    expect(await twoFactorRequirement()).toBe('admin');
    await setTwoFactorRequirement(request, by, 'member');
    expect(await settings.get('two_factor_required')).toBe('member');
    expect(await twoFactorRequirement()).toBe('member');
    await setTwoFactorRequirement(request, by, 'member');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(request, 'team.two_factor_requirement', {
      actor: by,
      detail: { from: 'admin', to: 'member' },
    });
  });

  it('refreshes the cached requirement and refuses invalid stored values', async () => {
    const { twoFactorRequirement } = await import('~/lib/settings.server');
    const set = (value: string) =>
      settings.set({
        key: 'two_factor_required',
        value,
        updatedAt: Date.now(),
        updatedBy: 'admin',
      });
    expect(await twoFactorRequirement()).toBe('admin');
    await set('off');
    expect(await twoFactorRequirement()).toBe('admin');
    vi.advanceTimersByTime(30_001);
    expect(await twoFactorRequirement()).toBe('off');
    await set('invalid');
    vi.advanceTimersByTime(30_001);
    expect(await twoFactorRequirement()).toBe('admin');
  });

  it('makes SSO-only effective only with a configured provider', async () => {
    const { ssoSettings, setSsoSettings, ssoOnlyInEffect } = await import('~/lib/settings.server');
    const next = { ...(await ssoSettings()), ssoOnly: true };
    await setSsoSettings(request, by, next);
    expect(JSON.parse((await settings.get('sso'))!)).toEqual(next);
    expect(await ssoOnlyInEffect()).toBe(false);
    Object.assign(env, {
      OIDC_ISSUER: 'https://id.example.com',
      OIDC_CLIENT_ID: 'client',
      OIDC_CLIENT_SECRET: 'secret',
    });
    expect(await ssoOnlyInEffect()).toBe(true);
    await setSsoSettings(request, by, { ...next, ssoOnly: false }, 'setup code');
    expect(await ssoOnlyInEffect()).toBe(false);
    expect(audit).toHaveBeenLastCalledWith(request, 'team.sso_settings', {
      actor: by,
      detail: { from: next, to: { ...next, ssoOnly: false }, via: 'setup code' },
    });
  });
});
