import { InMemoryAdminSettings } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, unknown> = {};
vi.mock('cloudflare:workers', () => ({ env }));

let settings = new InMemoryAdminSettings();
vi.mock('~/lib/wire.server', () => ({ adminSettings: () => settings }));
const audit = vi.fn();
vi.mock('~/lib/audit.server', () => ({ audit, clientIp: () => '203.0.113.7' }));
const recordFailure = vi.fn();
let people = false;
vi.mock('~/lib/auth.server', () => ({
  authEnabled: async () => people,
  waitFor: async () => 0,
  recordFailure,
  Throttled: class extends Error {},
}));
const insertAdmin = vi.fn();
class TeamError extends Error {}
vi.mock('~/lib/team.server', () => ({ insertAdmin, TeamError }));

const { redeemSetupCode, setupOpen } = await import('~/lib/setup.server');
const admin = { email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' };
const req = () => new Request('https://acme.commerceworker.com/setup', { method: 'POST' });

describe('setup code', () => {
  beforeEach(() => {
    settings = new InMemoryAdminSettings();
    people = false;
    env.SETUP_TOKEN = 'code-1';
    audit.mockReset();
    recordFailure.mockReset();
    insertAdmin.mockReset();
    insertAdmin.mockResolvedValue('usr_ada');
  });

  it('creates the first admin once, then stops working', async () => {
    expect(await setupOpen()).toBe(true);
    expect(await redeemSetupCode(req(), ' code-1 ', admin)).toBe('usr_ada');
    expect(insertAdmin).toHaveBeenCalledWith(expect.any(Request), admin, 'team.first_admin');
    expect(await setupOpen()).toBe(false);
    await expect(redeemSetupCode(req(), 'code-1', admin)).rejects.toThrow(/has been used/);
    expect(insertAdmin).toHaveBeenCalledTimes(1);
  });

  it('creates only one admin when the same code is submitted concurrently', async () => {
    const results = await Promise.allSettled([
      redeemSetupCode(req(), 'code-1', admin),
      redeemSetupCode(req(), 'code-1', admin),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(insertAdmin).toHaveBeenCalledTimes(1);
  });

  it('counts and audits a wrong code, and creates no one', async () => {
    await expect(redeemSetupCode(req(), 'guess', admin)).rejects.toThrow(/not right/);
    expect(recordFailure).toHaveBeenCalledWith(['setup-ip:203.0.113.7']);
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'team.setup_refused', {
      detail: { reason: 'wrong code' },
    });
    expect(insertAdmin).not.toHaveBeenCalled();
  });

  it('keeps the code working when the account could not be created', async () => {
    insertAdmin.mockRejectedValueOnce(new TeamError('Enter a valid email address.'));
    await expect(redeemSetupCode(req(), 'code-1', admin)).rejects.toThrow(/valid email/);
    expect(await setupOpen()).toBe(true);
  });

  it('recovers admin access with a new code once the team has people', async () => {
    await redeemSetupCode(req(), 'code-1', admin);
    people = true;
    env.SETUP_TOKEN = 'code-2';
    expect(await setupOpen()).toBe(true);
    await redeemSetupCode(req(), 'code-2', { ...admin, email: 'grace@example.com' });
    expect(insertAdmin).toHaveBeenLastCalledWith(
      expect.any(Request),
      { ...admin, email: 'grace@example.com' },
      'team.recovery_admin',
    );
  });

  it('opens nothing without a code', async () => {
    delete env.SETUP_TOKEN;
    expect(await setupOpen()).toBe(false);
    await expect(redeemSetupCode(req(), 'anything', admin)).rejects.toThrow(/no setup code/);
  });
});
