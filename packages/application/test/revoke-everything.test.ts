import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  createApiKey,
  createPersonalAccessToken,
  revokeEverythingFor,
} from '../src/index';

const hasher = { hash: (v: string) => `h:${v}` };

function setup() {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  store.seedSpace({ spaceId: 's2', defaultLocale: 'en-US', locales: ['en-US'] });
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('x') };
  // Personal tokens are minted only for enabled team members.
  const at = new Date(0).toISOString();
  for (const [spaceId, subject] of [
    ['s1', 'usr_ann'],
    ['s2', 'usr_ann'],
    ['s1', 'usr_bob'],
  ]) {
    void store.members.save({
      id: `m-${spaceId}-${subject}`,
      spaceId: spaceId as string,
      email: `${subject}@example.com`,
      subject,
      roleId: 'r',
      disabled: false,
      createdAt: at,
      updatedAt: at,
    });
  }
  return { ctx, store };
}

describe('revokeEverythingFor', () => {
  it('revokes a person’s tokens in every space and leaves everyone else’s', async () => {
    const { ctx, store } = setup();
    await createPersonalAccessToken(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      subject: 'usr_ann',
      name: 'cli',
      scopes: ['delivery:read'],
      issuerScopes: ['delivery:read'],
    });
    await createPersonalAccessToken(ctx, hasher, {
      issuer: 'system',
      spaceId: 's2',
      subject: 'usr_ann',
      name: 'ci',
      scopes: ['delivery:read'],
      issuerScopes: ['delivery:read'],
    });
    await createPersonalAccessToken(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      subject: 'usr_bob',
      name: 'bob',
      scopes: ['delivery:read'],
      issuerScopes: ['delivery:read'],
    });
    const { apiKey: siteKey } = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cda',
      name: 'site',
    });

    expect(await revokeEverythingFor(ctx, 'usr_ann')).toMatchObject({ revokedTokens: 2 });
    const all = [...(await store.auth.list('s1')), ...(await store.auth.list('s2'))];
    expect(all.filter((k) => k.subject === 'usr_ann').every((k) => k.revoked)).toBe(true);
    expect(all.find((k) => k.subject === 'usr_bob')?.revoked).toBe(false);
    // A space's own API keys are not a person's to lose.
    expect(all.find((k) => k.id === siteKey.id)?.revoked).toBe(false);
    // Idempotent.
    expect(await revokeEverythingFor(ctx, 'usr_ann')).toMatchObject({ revokedTokens: 0 });
  });
});
