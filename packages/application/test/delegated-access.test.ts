import { ForbiddenError, SCOPES, UnauthorizedError, ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  addMember,
  authenticate,
  createApiKey,
  createPersonalAccessToken,
  ensureRolePresets,
  findMemberForSignIn,
  memberAccess,
  presetRoleId,
  removeMember,
  updateMember,
  webUserAccess,
} from '../src/index';

const hasher = { hash: (v: string) => `h:${v}` };
const SSO = { sso: true };
const ann = { sub: 'usr_ann', email: 'ann@example.com', role: 'member' as const };
const boss = { sub: 'usr_boss', email: 'boss@example.com', role: 'admin' as const };

async function setup() {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('d') };
  await ensureRolePresets(ctx, 's1');
  // A second administrator keeps the last-admin guard out of the way.
  await addMember(ctx, 's1', { email: 'keeper@example.com', role: 'admin' });
  const member = await addMember(ctx, 's1', { email: ann.email, role: 'editor' });
  await findMemberForSignIn(ctx, 's1', ann.sub, ann.email);
  const { token } = await createPersonalAccessToken(ctx, hasher, {
    issuer: 'system',
    spaceId: 's1',
    subject: ann.sub,
    name: 'cli',
    scopes: [SCOPES.deliveryRead, SCOPES.contentWrite],
    issuerScopes: [SCOPES.deliveryRead, SCOPES.contentWrite],
  });
  return { ctx, member, token };
}

describe('a person’s tokens follow their place on the team', () => {
  it('stop working the moment they are disabled', async () => {
    const { ctx, member, token } = await setup();
    expect((await authenticate(ctx, hasher, token)).subject).toBe(ann.sub);
    await updateMember(ctx, 's1', member.id, { disabled: true }, SSO);
    await expect(authenticate(ctx, hasher, token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('stop working when they are removed from the team', async () => {
    const { ctx, member, token } = await setup();
    await removeMember(ctx, 's1', member.id, SSO);
    await expect(authenticate(ctx, hasher, token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('take on a downgrade at once, and never widen past what was consented', async () => {
    const { ctx, member, token } = await setup();
    await updateMember(ctx, 's1', member.id, { role: 'viewer' }, SSO);
    const principal = await authenticate(ctx, hasher, token);
    expect(principal.scopes).not.toContain(SCOPES.contentWrite);
    await updateMember(ctx, 's1', member.id, { role: 'admin' }, SSO);
    expect((await authenticate(ctx, hasher, token)).scopes).not.toContain(SCOPES.spaceAdmin);
  });
});

describe('credentials are always bound to one real space', () => {
  it('refuses the reserved `*` and unknown spaces for people', async () => {
    const { ctx } = await setup();
    await expect(webUserAccess(ctx, '*', boss)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(webUserAccess(ctx, 'nope', boss)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('never stores a key for `*`', async () => {
    const { ctx } = await setup();
    await expect(
      createApiKey(ctx, hasher, { issuer: 'system', spaceId: '*', kind: 'cma' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('lets only team members grant long-lived credentials, admins included', async () => {
    const { ctx } = await setup();
    // A deployment admin can act in a space without being on its team…
    expect((await webUserAccess(ctx, 's1', boss)).scopes).toContain(SCOPES.spaceAdmin);
    // …but can't mint a credential for it: nothing would back it on use.
    await expect(memberAccess(ctx, 's1', boss)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await memberAccess(ctx, 's1', ann)).roleId).toBe(
      await presetRoleId(ctx, 's1', 'editor'),
    );
  });
});
