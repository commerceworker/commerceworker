import { describe, expect, it } from 'vitest';
import {
  assertSecureSecrets,
  createHasher,
  DEV_TOKEN_DEFAULTS,
  requireSecureSecretsFromEnv,
  secureTokenEqual,
} from '../src/token-crypto';

describe('token-crypto', () => {
  it('secureTokenEqual rejects length mismatch', () => {
    expect(secureTokenEqual('abc', 'abcd')).toBe(false);
  });

  it('createHasher applies pepper', () => {
    const a = createHasher('pepper').hash('token');
    const b = createHasher().hash('token');
    expect(a).not.toBe(b);
  });

  it('assertSecureSecrets rejects dev defaults in production mode', () => {
    expect(() =>
      assertSecureSecrets({
        requireSecureSecrets: true,
        seedDev: true,
        adminToken: 'dev-admin-token',
      }),
    ).toThrow(/Insecure configuration/);
  });

  it('rejects the dev session secret when required', () => {
    expect(() =>
      assertSecureSecrets({
        requireSecureSecrets: true,
        seedDev: false,
        adminToken: 'a'.repeat(32),
        sessionSecret: 'dev-session-secret-change-me-in-production',
      }),
    ).toThrow(/SESSION_SECRET/);
  });

  it('accepts a strong session secret', () => {
    expect(() =>
      assertSecureSecrets({
        requireSecureSecrets: true,
        seedDev: false,
        adminToken: 'a'.repeat(32),
        sessionSecret: 's'.repeat(40),
      }),
    ).not.toThrow();
  });

  it('requireSecureSecretsFromEnv is true when NODE_ENV=production', () => {
    expect(requireSecureSecretsFromEnv({ NODE_ENV: 'production' })).toBe(true);
  });

  it('REQUIRE_SECURE_SECRETS=false overrides NODE_ENV=production', () => {
    expect(
      requireSecureSecretsFromEnv({ NODE_ENV: 'production', REQUIRE_SECURE_SECRETS: 'false' }),
    ).toBe(false);
  });

  it('lists known dev token defaults', () => {
    expect(DEV_TOKEN_DEFAULTS.has('dev-cma-key')).toBe(true);
  });
});
