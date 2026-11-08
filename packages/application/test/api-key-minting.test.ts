import { type Principal, SCOPES, scopesForKind } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  addMember,
  assignApiKeyRole,
  assignRolePreset,
  authenticate,
  createApiKey,
  createPersonalAccessToken,
  createRole,
  createSpace,
  presetRoleId,
  updateRole,
} from '../src/index';

const hasher = { hash: (v: string) => `h:${v}` };
const NO_SSO = { sso: false };
const S = 's1';

/** A person signed in to the admin, as the web Worker's signed principal resolves. */
const person: Principal = {
  spaceId: S,
  kind: 'user',
  subject: 'ada@example.com',
  scopes: [SCOPES.spaceAdmin],
};
/** An operator key with space:admin. */
const operator: Principal = { spaceId: S, kind: 'cma', scopes: [...scopesForKind('cma')] };

describe('minting and widening API keys', () => {
  let ctx: AppContext;
  let pat: Principal;
  let oauth: Principal;
  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('k'),
    };
    await createSpace(ctx, { spaceId: S, name: 'S', defaultLocale: 'en-US' });
    // Ada, signed in once (so her row is linked to her subject).
    const member = await addMember(ctx, S, { email: 'ada@example.com', role: 'admin' });
    await ctx.store.members.save({ ...member, subject: 'ada@example.com' });
    // A real personal access token, resolved as every request resolves it.
    const minted = await createPersonalAccessToken(ctx, hasher, {
      issuer: 'system',
      spaceId: S,
      subject: 'ada@example.com',
      name: 'ci',
      scopes: [SCOPES.spaceAdmin],
      expiresInDays: 30,
      issuerScopes: [SCOPES.spaceAdmin],
    });
    pat = await authenticate(ctx, hasher, minted.token);
    // An OAuth-issued principal: what `authenticate` resolves for a `cwo_` token.
    oauth = { ...person, clientId: 'client-1', issuance: 'oauth' };
  });

  it('resolves a personal access token as delegated', () => {
    expect(pat).toMatchObject({ kind: 'user', issuance: 'pat', scopes: [SCOPES.spaceAdmin] });
  });

  it('refuses a personal access token and an OAuth token, and lets a person or operator key mint', async () => {
    for (const issuer of [pat, oauth]) {
      await expect(createApiKey(ctx, hasher, { spaceId: S, kind: 'cma', issuer })).rejects.toThrow(
        /can't mint an API key/,
      );
    }
    for (const issuer of [person, operator]) {
      await expect(
        createApiKey(ctx, hasher, { spaceId: S, kind: 'cda', issuer }),
      ).resolves.toMatchObject({ apiKey: { kind: 'cda' } });
    }
    // Only the two keys minted by the person and the operator (and the PAT) exist.
    expect((await ctx.store.auth.list(S)).filter((k) => k.issuance === 'key')).toHaveLength(2);
  });

  it('lets a delegated bearer narrow a key, never widen one', async () => {
    const viewer = await presetRoleId(ctx, S, 'viewer');
    const key = (
      await createApiKey(ctx, hasher, {
        issuer: 'system',
        spaceId: S,
        kind: 'cma',
        roleId: await presetRoleId(ctx, S, 'manager'),
      })
    ).apiKey;
    // Narrower scopes, and the same grants: allowed.
    await expect(assignApiKeyRole(ctx, S, key.id, 'editor', NO_SSO, pat)).resolves.toBeDefined();
    // Other grants, even narrower ones, count as a change it may not make (grants aren't ordered).
    await expect(assignApiKeyRole(ctx, S, key.id, 'approver', NO_SSO, pat)).rejects.toThrow(
      /widen/,
    );
    // Wider scopes: refused, over either use-case.
    await expect(assignApiKeyRole(ctx, S, key.id, 'admin', NO_SSO, pat)).rejects.toThrow(/widen/);
    await expect(
      assignRolePreset(ctx, S, { keyId: key.id }, 'manager', NO_SSO, oauth),
    ).rejects.toThrow(/widen/);
    // Off its role, to the kind's unrestricted defaults: refused.
    await expect(assignApiKeyRole(ctx, S, key.id, null, NO_SSO, pat)).rejects.toThrow(/widen/);
    // The person may do any of it.
    await expect(assignApiKeyRole(ctx, S, key.id, viewer, NO_SSO, operator)).resolves.toBeDefined();
    await expect(assignApiKeyRole(ctx, S, key.id, 'admin', NO_SSO, person)).resolves.toBeDefined();
  });

  it('refuses a delegated bearer widening a key through the role it holds, not narrowing it', async () => {
    const role = await createRole(ctx, S, {
      name: 'Build',
      scopes: [SCOPES.previewRead, SCOPES.deliveryRead],
      contentGrants: [{ contentTypeApiId: 'article', actions: ['read'] }],
    });
    const edit = (scopes: string[], contentGrants = role.contentGrants) => ({
      name: 'Build',
      scopes,
      contentGrants,
    });
    // No key holds it yet: a role is just a definition, and the bearer may shape it.
    await expect(
      updateRole(
        ctx,
        S,
        role.id,
        edit([SCOPES.previewRead, SCOPES.deliveryRead, SCOPES.contentWrite]),
        NO_SSO,
        pat,
      ),
    ).resolves.toBeDefined();
    await updateRole(
      ctx,
      S,
      role.id,
      edit([SCOPES.previewRead, SCOPES.deliveryRead]),
      NO_SSO,
      person,
    );
    await createApiKey(ctx, hasher, { issuer: 'system', spaceId: S, kind: 'cda', roleId: role.id });

    for (const bearer of [pat, oauth]) {
      // New scopes.
      await expect(
        updateRole(
          ctx,
          S,
          role.id,
          edit([SCOPES.previewRead, SCOPES.deliveryRead, SCOPES.spaceAdmin]),
          NO_SSO,
          bearer,
        ),
      ).rejects.toThrow(/widen/);
      // Content grants dropped (an empty list is unrestricted) or changed.
      await expect(
        updateRole(
          ctx,
          S,
          role.id,
          edit([SCOPES.previewRead, SCOPES.deliveryRead], []),
          NO_SSO,
          bearer,
        ),
      ).rejects.toThrow(/widen/);
    }
    // Narrower scopes, same grants: allowed.
    await expect(
      updateRole(ctx, S, role.id, edit([SCOPES.deliveryRead]), NO_SSO, pat),
    ).resolves.toMatchObject({ scopes: [SCOPES.deliveryRead] });
    // A signed-in person may widen it.
    await expect(
      updateRole(
        ctx,
        S,
        role.id,
        edit([SCOPES.deliveryRead, SCOPES.contentWrite], []),
        NO_SSO,
        person,
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a personal access token or an OAuth token minting a personal access token', async () => {
    for (const issuer of [pat, oauth]) {
      await expect(
        createPersonalAccessToken(ctx, hasher, {
          issuer,
          spaceId: S,
          subject: 'ada@example.com',
          name: 'forever',
          scopes: [SCOPES.spaceAdmin],
          issuerScopes: [SCOPES.spaceAdmin],
        }),
      ).rejects.toThrow(/can't mint/);
    }
    await expect(
      createPersonalAccessToken(ctx, hasher, {
        issuer: person,
        spaceId: S,
        subject: 'ada@example.com',
        name: 'ci',
        scopes: [SCOPES.spaceAdmin],
        issuerScopes: [SCOPES.spaceAdmin],
      }),
    ).resolves.toMatchObject({ token: expect.stringMatching(/^cwpat_/) });
  });
});
