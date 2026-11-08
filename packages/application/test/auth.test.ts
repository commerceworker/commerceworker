import {
  authorize,
  ForbiddenError,
  NotFoundError,
  SCOPES,
  UnauthorizedError,
} from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { type AppContext, authenticate, createApiKey, revokeApiKey } from '../src/index';

// A trivial deterministic hasher for tests.
const hasher = { hash: (v: string) => `h:${v}` };

function ctx(): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('k'),
  };
}

describe('RBAC: API keys + authorization', () => {
  it('mints a key, stores only the hash, and authenticates the raw token', async () => {
    const c = ctx();
    const { apiKey, token } = await createApiKey(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      name: 'k',
    });
    expect(token.startsWith('cwk_cma_')).toBe(true);
    // The stored value is the hasher's output, not the raw token.
    expect(apiKey.hashedToken).toBe(hasher.hash(token));

    const principal = await authenticate(c, hasher, token);
    expect(principal.spaceId).toBe('s1');
    expect(principal.kind).toBe('cma');
    expect(principal.scopes).toContain(SCOPES.contentWrite);
  });

  it('mints a high-entropy token with no embedded structure', async () => {
    const c = ctx();
    const { token } = await createApiKey(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
    });
    const secret = token.replace('cwk_cma_', '');
    // base64url charset, long enough for a 32-byte CSPRNG secret, and NOT the old
    // 64-hex-char (concatenated-UUID) shape.
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(secret).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints a key without a name (name is optional)', async () => {
    const c = ctx();
    // The admin labels the field "Name (optional)"; omitting it must not fail.
    const { apiKey, token } = await createApiKey(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cda',
    });
    expect(apiKey.name).toBeUndefined();
    const principal = await authenticate(c, hasher, token);
    expect(principal.kind).toBe('cda');
  });

  it('revokes a key so its token no longer authenticates', async () => {
    const c = ctx();
    // A delivery key: the space's last administrator can't be revoked (see team.test.ts).
    const { apiKey, token } = await createApiKey(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cda',
    });
    await expect(authenticate(c, hasher, token)).resolves.toBeTruthy();
    await revokeApiKey(c, 's1', apiKey.id);
    await expect(authenticate(c, hasher, token)).rejects.toBeInstanceOf(UnauthorizedError);
    // Revoking a key from another space (or a missing key) is a 404.
    await expect(revokeApiKey(c, 's2', apiKey.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects unknown / missing tokens with UnauthorizedError', async () => {
    const c = ctx();
    await expect(authenticate(c, hasher, undefined)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(authenticate(c, hasher, 'nope')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('stops authenticating an expired key', async () => {
    const clock = new FixedClock();
    const c: AppContext = {
      store: new InMemoryContentStore(),
      clock,
      ids: new SequenceIdGenerator('k'),
    };
    const expiresAt = new Date(clock.now().getTime() + 60_000).toISOString();
    const { token } = await createApiKey(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      expiresAt,
    });
    // Valid before expiry...
    await expect(authenticate(c, hasher, token)).resolves.toBeTruthy();
    // ...and rejected once the clock passes expiresAt.
    clock.advance(61_000);
    await expect(authenticate(c, hasher, token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('authorize enforces scope and space boundaries', async () => {
    const cda = { spaceId: 's1', kind: 'cda' as const, scopes: [SCOPES.deliveryRead] };
    // Has the scope in its own space.
    expect(() => authorize(cda, SCOPES.deliveryRead, 's1')).not.toThrow();
    // Lacks the write scope.
    expect(() => authorize(cda, SCOPES.contentWrite, 's1')).toThrow(ForbiddenError);
    // Right scope, wrong space.
    expect(() => authorize(cda, SCOPES.deliveryRead, 's2')).toThrow(ForbiddenError);
    // Admin (wildcard space) may act anywhere.
    const admin = { spaceId: '*', kind: 'admin' as const, scopes: [SCOPES.contentWrite] };
    expect(() => authorize(admin, SCOPES.contentWrite, 'any-space')).not.toThrow();
  });
});
