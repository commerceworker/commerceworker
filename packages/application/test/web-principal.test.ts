import { ForbiddenError, SCOPES } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  addMember,
  ensureRolePresets,
  NO_SSO,
  principalForWebUser,
  updateMember,
} from '../src/index';

async function setup() {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('x') };
  await ensureRolePresets(ctx, 's1');
  return ctx;
}

const member = { sub: 'usr_1', email: 'ed@example.com', role: 'member' as const };
const admin = { sub: 'usr_9', email: 'boss@example.com', role: 'admin' as const };

describe('principalForWebUser', () => {
  it('resolves a team member to their role in the space', async () => {
    const ctx = await setup();
    await addMember(ctx, 's1', { email: 'ed@example.com', name: 'Ed', role: 'viewer' });
    const p = await principalForWebUser(ctx, 's1', member);
    expect(p).toMatchObject({ spaceId: 's1', kind: 'user', subject: 'usr_1' });
    expect(p.scopes).toContain(SCOPES.previewRead);
    expect(p.scopes).not.toContain(SCOPES.contentWrite);
  });

  it('refuses a member who is not on the team, or is disabled', async () => {
    const ctx = await setup();
    await expect(principalForWebUser(ctx, 's1', member)).rejects.toBeInstanceOf(ForbiddenError);
    const m = await addMember(ctx, 's1', { email: 'ed@example.com', name: 'Ed', role: 'editor' });
    await updateMember(ctx, 's1', m.id, { disabled: true }, NO_SSO);
    await expect(principalForWebUser(ctx, 's1', member)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets a deployment admin administer any space and the deployment', async () => {
    const ctx = await setup();
    expect((await principalForWebUser(ctx, 's1', admin)).scopes).toContain(SCOPES.spaceAdmin);
    expect((await principalForWebUser(ctx, undefined, admin)).spaceId).toBe('*');
    // A member outside any space holds nothing: no space, no scopes (only listing their own).
    expect(await principalForWebUser(ctx, undefined, member)).toMatchObject({
      spaceId: '',
      scopes: [],
    });
  });
});
