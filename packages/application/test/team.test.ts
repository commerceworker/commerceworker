import {
  LastAdminError,
  ROLE_PRESET_DEFINITIONS,
  SCOPES,
  UnauthorizedError,
  ValidationError,
} from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AccessPolicy,
  type AppContext,
  addMember,
  assignApiKeyRole,
  assignRolePreset,
  authenticate,
  cloneRole,
  createApiKey,
  createSpace,
  deleteRole,
  ensureRolePresets,
  findMemberForSignIn,
  listRolePresets,
  listTeam,
  presetRoleId,
  removeMember,
  revokeApiKey,
  setSsoOnly,
  updateMember,
  updateRole,
} from '../src/index';

const hasher = { hash: (v: string) => `h:${v}` };
const SSO: AccessPolicy = { sso: true };
const NO_SSO: AccessPolicy = { sso: false };

describe('role presets', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('t'),
    };
  });

  it('maps each preset onto scopes, each one including the one before it', () => {
    const scopes = Object.fromEntries(ROLE_PRESET_DEFINITIONS.map((d) => [d.preset, d.scopes]));
    expect(scopes.viewer).toEqual([SCOPES.previewRead, SCOPES.deliveryRead, SCOPES.searchRead]);
    expect(scopes.approver).toEqual([...(scopes.viewer ?? []), SCOPES.workflowApprove]);
    expect(scopes.editor).toEqual([
      ...(scopes.approver ?? []),
      SCOPES.contentWrite,
      SCOPES.contentPublish,
    ]);
    expect(scopes.manager).toEqual([...(scopes.editor ?? []), SCOPES.contentManage]);
    expect(scopes.admin).toEqual([...(scopes.manager ?? []), SCOPES.spaceAdmin]);
    // Admin holds every scope there is.
    expect(new Set(scopes.admin)).toEqual(new Set(Object.values(SCOPES)));
    // Every preset reaches every content type: viewers and approvers read, editors and up write.
    const grants = Object.fromEntries(
      ROLE_PRESET_DEFINITIONS.map((d) => [d.preset, d.contentGrants]),
    );
    expect(grants.viewer).toEqual([{ contentTypeApiId: '*', actions: ['read'] }]);
    expect(grants.approver).toEqual([{ contentTypeApiId: '*', actions: ['read'] }]);
    for (const p of ['editor', 'manager', 'admin']) {
      expect(grants[p]).toEqual([{ contentTypeApiId: '*', actions: ['read', 'write', 'publish'] }]);
    }
  });

  it('seeds the presets with a new space, once, as editable roles', async () => {
    await createSpace(ctx, { spaceId: 's1', name: 'S', defaultLocale: 'en-US' });
    await ensureRolePresets(ctx, 's1');
    const roles = await ctx.store.roles.list('s1');
    expect(roles.map((r) => r.preset)).toEqual([
      'viewer',
      'approver',
      'editor',
      'manager',
      'admin',
    ]);
    expect(roles.map((r) => r.name)).toEqual([
      'Viewer',
      'Approver',
      'Editor',
      'Manager',
      'Administrator',
    ]);
    const viewer = roles[0];
    if (!viewer) throw new Error('no viewer');
    const edited = await updateRole(ctx, 's1', viewer.id, {
      name: 'Reader',
      scopes: [SCOPES.deliveryRead],
    });
    expect(edited.preset).toBe('viewer');
    expect((await listRolePresets(ctx, 's1'))[0]).toMatchObject({
      preset: 'viewer',
      name: 'Reader',
      scopes: [SCOPES.deliveryRead],
    });
  });

  it('refuses to delete a preset, and clones one into an ordinary role', async () => {
    const adminId = await presetRoleId(ctx, 's1', 'admin');
    await expect(deleteRole(ctx, 's1', adminId)).rejects.toBeInstanceOf(ValidationError);
    const copy = await cloneRole(ctx, 's1', adminId, 'Site owner');
    expect(copy.name).toBe('Site owner');
    expect(copy.preset).toBeUndefined();
    expect(copy.scopes).toContain(SCOPES.spaceAdmin);
    await deleteRole(ctx, 's1', copy.id);
  });

  it('binds a key to a preset, resolved live like any role', async () => {
    const { apiKey, token } = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cda',
    });
    await assignRolePreset(ctx, 's1', { keyId: apiKey.id }, 'approver', NO_SSO, 'system');
    const principal = await authenticate(ctx, hasher, token);
    expect(principal.scopes).toContain(SCOPES.workflowApprove);
    expect(principal.scopes).not.toContain(SCOPES.contentWrite);
    // Unbinding falls back to the kind's defaults.
    await assignApiKeyRole(ctx, 's1', apiKey.id, null, NO_SSO, 'system');
    expect((await authenticate(ctx, hasher, token)).scopes).toEqual([
      SCOPES.deliveryRead,
      SCOPES.searchRead,
    ]);
  });
});

describe('the last administrator', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('t'),
    };
  });

  it('can’t be revoked or demoted while they are the only one', async () => {
    const adminRole = await presetRoleId(ctx, 's1', 'admin');
    const a = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      roleId: adminRole,
    });
    await expect(revokeApiKey(ctx, 's1', a.apiKey.id)).rejects.toBeInstanceOf(LastAdminError);
    await expect(
      assignRolePreset(ctx, 's1', { keyId: a.apiKey.id }, 'editor', NO_SSO, 'system'),
    ).rejects.toBeInstanceOf(LastAdminError);
    // A second admin makes the first one revocable.
    await createApiKey(ctx, hasher, { issuer: 'system', spaceId: 's1', kind: 'cma' });
    await revokeApiKey(ctx, 's1', a.apiKey.id);
  });

  it('keeps the admin role’s space:admin while it is all that makes anyone an admin', async () => {
    const adminRole = await presetRoleId(ctx, 's1', 'admin');
    await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      roleId: adminRole,
    });
    await expect(
      updateRole(ctx, 's1', adminRole, { name: 'Administrator', scopes: [SCOPES.previewRead] }),
    ).rejects.toBeInstanceOf(LastAdminError);
  });

  it('ignores short-lived and revoked keys: they are not seats', async () => {
    const adminRole = await presetRoleId(ctx, 's1', 'admin');
    const a = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      roleId: adminRole,
    });
    // An SSO session key with an expiry doesn't count as a second admin.
    await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      name: 'oidc:someone',
      roleId: adminRole,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await expect(revokeApiKey(ctx, 's1', a.apiKey.id)).rejects.toBeInstanceOf(LastAdminError);
  });

  it('counts people only when SSO is configured, and guards demote/disable/remove', async () => {
    const person = await addMember(ctx, 's1', { email: 'Ada@Example.com', role: 'admin' });
    expect(person.email).toBe('ada@example.com');
    // Without SSO the person can't sign in, so they are no seat: nothing to protect.
    await updateMember(ctx, 's1', person.id, { role: 'viewer' }, NO_SSO);
    await updateMember(ctx, 's1', person.id, { role: 'admin' }, NO_SSO);
    for (const change of [
      () => updateMember(ctx, 's1', person.id, { role: 'editor' }, SSO),
      () => updateMember(ctx, 's1', person.id, { disabled: true }, SSO),
      () => removeMember(ctx, 's1', person.id, SSO),
    ]) {
      await expect(change()).rejects.toBeInstanceOf(LastAdminError);
    }
    const other = await addMember(ctx, 's1', { email: 'grace@example.com', role: 'admin' });
    await updateMember(ctx, 's1', person.id, { disabled: true }, SSO);
    await expect(removeMember(ctx, 's1', other.id, SSO)).rejects.toBeInstanceOf(LastAdminError);
  });

  it('lists the team with roles and the admin count', async () => {
    const adminRole = await presetRoleId(ctx, 's1', 'admin');
    await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      roleId: adminRole,
      name: 'ci',
    });
    await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      name: 'oidc:x',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await addMember(ctx, 's1', { email: 'v@example.com', role: 'viewer' });
    const team = await listTeam(ctx, 's1', SSO);
    expect(team.adminCount).toBe(1);
    expect(team.keys).toHaveLength(1);
    expect(team.keys[0]).toMatchObject({
      name: 'ci',
      admin: true,
      role: { name: 'Administrator', preset: 'admin' },
    });
    expect(team.people[0]).toMatchObject({ email: 'v@example.com', role: { preset: 'viewer' } });
  });
});

describe('SSO people and SSO-only sign-in', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('t'),
    };
  });

  it('links a person to their SSO subject on first sign-in', async () => {
    await addMember(ctx, 's1', { email: 'ada@example.com', role: 'editor' });
    const first = await findMemberForSignIn(ctx, 's1', 'sub-1', 'ADA@example.com');
    expect(first?.subject).toBe('sub-1');
    // Later sign-ins find them by subject even if the provider's email changes.
    expect((await findMemberForSignIn(ctx, 's1', 'sub-1', 'new@example.com'))?.id).toBe(first?.id);
  });

  it('refuses SSO-only without SSO or an SSO admin, then stops setup credentials', async () => {
    await expect(setSsoOnly(ctx, 's1', true, NO_SSO)).rejects.toBeInstanceOf(ValidationError);
    await expect(setSsoOnly(ctx, 's1', true, SSO)).rejects.toMatchObject({
      issues: [{ field: 'ssoOnly', message: expect.stringMatching(/Administrator/) }],
    });
    await addMember(ctx, 's1', { email: 'ada@example.com', role: 'admin' });
    // Her first sign-in links her subject to the membership her credentials are checked against.
    await findMemberForSignIn(ctx, 's1', 'ada@example.com', 'ada@example.com');
    const adminRole = await presetRoleId(ctx, 's1', 'admin');
    const { token } = await createApiKey(ctx, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      roleId: adminRole,
      issuance: 'setup',
      subject: 'ada@example.com',
    });
    expect((await authenticate(ctx, hasher, token)).kind).toBe('user');
    await setSsoOnly(ctx, 's1', true, SSO);
    await expect(authenticate(ctx, hasher, token)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
