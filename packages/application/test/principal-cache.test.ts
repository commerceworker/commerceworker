import { UnauthorizedError } from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryCache,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  authenticate,
  authenticateCached,
  createApiKey,
  createRole,
  LAST_USED_RESOLUTION_MS,
  revokeApiKey,
  updateRole,
} from '../src/index';

const hasher = { hash: (v: string) => `h:${v}` };

function ctx(): AppContext & { store: InMemoryContentStore } {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('k'),
    cache: new InMemoryCache(),
  };
}

describe('authenticateCached', () => {
  it('serves a repeat authentication from cache without reading the key again', async () => {
    const c = ctx();
    const { token } = await createApiKey(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cda',
      name: 'site',
    });
    const first = await authenticateCached(c, hasher, token);
    const findByHash = vi.spyOn(c.store.auth, 'findByHash');
    const second = await authenticateCached(c, hasher, token);
    expect(second).toEqual(first);
    expect(findByHash).not.toHaveBeenCalled();
  });

  it('stops serving a revoked key immediately (the space tag is invalidated)', async () => {
    const c = ctx();
    const { apiKey, token } = await createApiKey(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cda',
      name: 'site',
    });
    await authenticateCached(c, hasher, token);
    await revokeApiKey(c, 's1', apiKey.id);
    await expect(authenticateCached(c, hasher, token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('serves a role-bound key its role’s new grants as soon as the role is edited', async () => {
    const c = ctx();
    const role = await createRole(c, 's1', {
      name: 'Writer',
      scopes: ['content:write'],
      contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write'] }],
    });
    const { token } = await createApiKey(c, hasher, {
      spaceId: 's1',
      kind: 'cma',
      roleId: role.id,
      issuer: 'system',
    });
    expect((await authenticateCached(c, hasher, token)).contentGrants?.[0]?.deniedActions).toBe(
      undefined,
    );
    await updateRole(c, 's1', role.id, {
      name: 'Writer',
      scopes: ['content:write'],
      contentGrants: [
        { contentTypeApiId: '*', actions: ['read', 'write'], deniedActions: ['delete'] },
      ],
    });
    expect((await authenticateCached(c, hasher, token)).contentGrants?.[0]?.deniedActions).toEqual([
      'delete',
    ]);
  });

  it('never caches a failure', async () => {
    const c = ctx();
    await expect(authenticateCached(c, hasher, 'cwk_nope')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(await c.cache?.get('principal:h:cwk_nope')).toBeNull();
  });
});

describe('lastUsedAt throttling', () => {
  it('writes last-used at most once per resolution window', async () => {
    const c = ctx();
    const { token } = await createApiKey(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cda',
      name: 'site',
    });
    const touch = vi.spyOn(c.store.auth, 'touchLastUsed');
    await authenticate(c, hasher, token);
    await new Promise((r) => setTimeout(r, 0));
    await authenticate(c, hasher, token);
    await new Promise((r) => setTimeout(r, 0));
    expect(touch).toHaveBeenCalledTimes(1);
    (c.clock as FixedClock).advance(LAST_USED_RESOLUTION_MS);
    await authenticate(c, hasher, token);
    await new Promise((r) => setTimeout(r, 0));
    expect(touch).toHaveBeenCalledTimes(2);
  });
});

describe('assertSecureSecrets and the principal key', () => {
  it('refuses the repo’s public dev principal key, and a short one', async () => {
    const { assertSecureSecrets } = await import('../src/index');
    const base = { requireSecureSecrets: true, seedDev: false, adminToken: '' };
    expect(() =>
      assertSecureSecrets({ ...base, principalKeys: ['commerceworker-local-dev-principal-key'] }),
    ).toThrow(/PRINCIPAL_KEY must not use a known dev default/);
    expect(() => assertSecureSecrets({ ...base, principalKeys: ['short'] })).toThrow(
      /PRINCIPAL_KEY must be at least 32/,
    );
    expect(() => assertSecureSecrets({ ...base, principalKeys: ['k'.repeat(64)] })).not.toThrow();
  });
});
