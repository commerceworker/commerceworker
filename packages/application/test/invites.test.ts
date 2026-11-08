import { createHash } from 'node:crypto';
import {
  ConflictError,
  ForbiddenError,
  InvalidInviteError,
  InvalidStateError,
  type InviteEmailDueEvent,
  type Principal,
  SCOPES,
  scopesForKind,
} from '@commerceworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  RecordingEmailSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  acceptInvite,
  addMember,
  consumeEvent,
  createInvite,
  createRole,
  createSpace,
  deliverInviteEmail,
  getInvite,
  isInviteToken,
  listInvites,
  previewInvite,
  resendInvite,
  revokeInvite,
} from '../src/index';

// A real digest: a test hasher that echoed its input would put the token in what is stored.
const hasher = { hash: (v: string) => createHash('sha256').update(`pepper${v}`).digest('hex') };
const ORIGIN = 'https://admin.example.com';
const DAY = 86_400_000;

/** A deployment admin signed in to the admin (the web's signed principal across spaces). */
const deploymentAdmin: Principal = {
  spaceId: '*',
  kind: 'user',
  subject: 'usr_ada',
  scopes: [...scopesForKind('cma')],
};
/** The web app acting for the deployment in the sign-up handshake. */
const web: Principal = {
  spaceId: '*',
  kind: 'user',
  subject: 'system:web',
  scopes: deploymentAdmin.scopes,
};

describe('invitations', () => {
  let ctx: AppContext;
  let clock: FixedClock;
  let store: InMemoryContentStore;
  beforeEach(async () => {
    clock = new FixedClock();
    store = new InMemoryContentStore();
    ctx = { store, clock, ids: new SequenceIdGenerator('i') };
    await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
    await createSpace(ctx, { spaceId: 'docs', name: 'Docs', defaultLocale: 'en-US' });
  });

  const invite = (input: Partial<Parameters<typeof createInvite>[3]> = {}, by = deploymentAdmin) =>
    createInvite(
      ctx,
      hasher,
      by,
      { email: 'Grace@Example.com', grants: [{ space: 'blog', role: 'editor' }], ...input },
      { origin: ORIGIN },
    );

  it('issues a link once and stores only its hash', async () => {
    const issued = await invite();
    expect(isInviteToken(issued.token)).toBe(true);
    expect(issued.url).toBe(`${ORIGIN}/invite/${issued.token}`);
    expect(issued.invite).toMatchObject({
      email: 'grace@example.com',
      role: 'member',
      status: 'pending',
    });
    expect(Date.parse(issued.invite.expiresAt) - clock.now().getTime()).toBe(7 * DAY);
    // Neither the view nor anything stored carries the token.
    expect(JSON.stringify(issued.invite)).not.toContain(issued.token);
    const stored = await store.invites.get(issued.invite.id);
    expect(stored?.tokenHash).toBe(hasher.hash(issued.token));
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    // The email event names the invitation, never a token or the address.
    const events = store.allEvents().filter((e) => e.type === 'invite.email_due');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(issued.token);
    expect(JSON.stringify(events)).not.toContain('grace@');
    // Listed, and audited in the space it grants a role in.
    expect((await listInvites(ctx, deploymentAdmin)).map((i) => i.id)).toEqual([issued.invite.id]);
    const audit = await store.audit.list('blog', {});
    expect(audit.map((a) => a.action)).toContain('invite.created');
  });

  it('refuses anyone who does not manage people across the deployment', async () => {
    const spaceAdmin: Principal = { spaceId: 'blog', kind: 'cma', scopes: scopesForKind('cma') };
    const member: Principal = { spaceId: '', kind: 'user', subject: 'usr_m', scopes: [] };
    await expect(invite({}, spaceAdmin)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(invite({}, member)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listInvites(ctx, spaceAdmin)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await store.invites.list({ now: clock.now() })).toHaveLength(0);
  });

  it('never grants more than the inviter holds', async () => {
    // A role carrying a scope the inviter lacks.
    const narrow: Principal = {
      ...deploymentAdmin,
      scopes: deploymentAdmin.scopes.filter((s) => s !== SCOPES.workflowApprove),
    };
    await expect(invite({ grants: [{ space: 'blog', role: 'approver' }] }, narrow)).rejects.toThrow(
      /workflow:approve/,
    );
    // Content grants wider than the inviter's own.
    const limited: Principal = {
      ...deploymentAdmin,
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read'] }],
    };
    await expect(invite({ grants: [{ space: 'blog', role: 'viewer' }] }, limited)).rejects.toThrow(
      /beyond your own/,
    );
    // A space admin elsewhere can't be the one who makes someone a deployment admin.
    const custom = await createRole(ctx, 'blog', { name: 'Ops', scopes: [SCOPES.spaceAdmin] });
    const blogAdmin: Principal = {
      spaceId: 'blog',
      kind: 'user',
      subject: 'usr_b',
      scopes: [SCOPES.spaceAdmin],
    };
    await expect(
      invite({ role: 'admin', grants: [{ space: 'blog', role: custom.id }] }, blogAdmin),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets only a person invite an admin, never a root token', async () => {
    const rootToken: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
    await expect(invite({ role: 'admin', grants: [] }, rootToken)).rejects.toThrow(
      /signed in to the admin/,
    );
    // A member invitation from a root token is still fine, and a person may invite an admin.
    await expect(invite({ grants: [] }, rootToken)).resolves.toBeTruthy();
    await expect(
      invite({ email: 'ada2@example.com', role: 'admin', grants: [] }),
    ).resolves.toBeTruthy();
  });

  it('reads one invitation by id, for deployment admins only', async () => {
    const issued = await invite();
    expect((await getInvite(ctx, deploymentAdmin, issued.invite.id)).role).toBe('member');
    const key: Principal = { spaceId: 'blog', kind: 'cma', scopes: scopesForKind('cma') };
    await expect(getInvite(ctx, key, issued.invite.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getInvite(ctx, deploymentAdmin, 'nope')).rejects.toThrow(/not found/);
  });

  describe('the audit line every action writes', () => {
    let lines: Record<string, unknown>[];
    beforeEach(() => {
      lines = [];
      vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        if (typeof line === 'string' && line.includes('invite_audit')) lines.push(JSON.parse(line));
      });
    });
    afterEach(() => vi.restoreAllMocks());

    it('is written even for an invitation that grants no space, and never carries the token', async () => {
      const rootToken: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
      const issued = await invite({ grants: [] }, rootToken);
      const again = await resendInvite(ctx, hasher, rootToken, issued.invite.id);
      await revokeInvite(ctx, rootToken, issued.invite.id);
      expect(lines.map((l) => [l.action, l.actor, l.inviteId])).toEqual([
        ['invite.created', 'admin-token', issued.invite.id],
        ['invite.resent', 'admin-token', issued.invite.id],
        ['invite.revoked', 'admin-token', issued.invite.id],
      ]);
      expect(lines[0]).toMatchObject({ role: 'member', spaces: [], email: 'grace@example.com' });
      const text = JSON.stringify(lines);
      expect(text).not.toContain(issued.token);
      expect(text).not.toContain(again.token);
      expect(text).not.toContain(hasher.hash(issued.token));
    });
  });

  it('validates the address, role, spaces and expiry, and refuses a second pending invitation', async () => {
    await expect(invite({ email: 'nope' })).rejects.toThrow(/invalid/i);
    await expect(invite({ grants: [{ space: 'missing', role: 'viewer' }] })).rejects.toThrow(
      /not found/,
    );
    await expect(invite({ grants: [{ space: '*', role: 'viewer' }] })).rejects.toThrow(/not found/);
    await expect(invite({ expiresInDays: 31 })).rejects.toThrow(/invalid/i);
    await invite();
    await expect(invite()).rejects.toBeInstanceOf(ConflictError);
  });

  it('previews and accepts once: the person joins each space with its role', async () => {
    const issued = await invite({
      grants: [
        { space: 'blog', role: 'editor' },
        { space: 'docs', role: 'viewer' },
      ],
    });
    const preview = await previewInvite(ctx, hasher, web, issued.token);
    expect(preview.spaces.map((s) => [s.name, s.role])).toEqual([
      ['Blog', 'Editor'],
      ['Docs', 'Viewer'],
    ]);
    const accepted = await acceptInvite(ctx, hasher, web, issued.token, {
      subject: 'usr_grace',
      email: 'grace@example.com',
    });
    expect(accepted.role).toBe('member');
    expect(accepted.grants.map((g) => g.outcome)).toEqual(['added', 'added']);
    const member = await store.members.getByEmail('blog', 'grace@example.com');
    expect(member).toMatchObject({ subject: 'usr_grace', disabled: false });
    expect(accepted.invite.status).toBe('accepted');
    // Used: the same link fails, with the one generic error.
    await expect(
      acceptInvite(ctx, hasher, web, issued.token, {
        subject: 'usr_grace',
        email: 'grace@example.com',
      }),
    ).rejects.toBeInstanceOf(InvalidInviteError);
    await expect(previewInvite(ctx, hasher, web, issued.token)).rejects.toBeInstanceOf(
      InvalidInviteError,
    );
    expect((await store.audit.list('docs', {})).map((a) => a.action)).toContain('invite.accepted');
  });

  it('fails cleanly when another accept wins the compare-and-set, changing nothing', async () => {
    const issued = await invite();
    // Another request accepts between this one's reads and its commit.
    const replace = store.invites.replace;
    let raced = false;
    store.invites.replace = async (next, expected) => {
      if (!raced) {
        raced = true;
        const current = await store.invites.get(next.id);
        if (current) await replace({ ...current, version: current.version + 1 }, current.version);
      }
      return replace(next, expected);
    };
    await expect(
      acceptInvite(ctx, hasher, web, issued.token, {
        subject: 'usr_2',
        email: 'grace@example.com',
      }),
    ).rejects.toBeInstanceOf(InvalidInviteError);
    // The unit rolled back whole: no team membership came from the lost accept.
    expect(await store.members.getByEmail('blog', 'grace@example.com')).toBeNull();
  });

  it('a used link fails on its second use', async () => {
    const issued = await invite();
    const person = { subject: 'usr_1', email: 'grace@example.com' };
    await acceptInvite(ctx, hasher, web, issued.token, person);
    await expect(acceptInvite(ctx, hasher, web, issued.token, person)).rejects.toBeInstanceOf(
      InvalidInviteError,
    );
    expect(await store.members.list('blog')).toHaveLength(1);
  });

  it('refuses a link for another address, a malformed or unknown one, and an expired one, alike', async () => {
    const issued = await invite();
    const other = { subject: 'usr_x', email: 'mallory@example.com' };
    const errors = await Promise.all([
      acceptInvite(ctx, hasher, web, issued.token, other).catch((e: Error) => e),
      acceptInvite(ctx, hasher, web, 'not-a-token', other).catch((e: Error) => e),
      acceptInvite(ctx, hasher, web, `cwi_${'A'.repeat(43)}`, other).catch((e: Error) => e),
    ]);
    for (const e of errors) {
      expect(e).toBeInstanceOf(InvalidInviteError);
      expect(e.message).toBe(new InvalidInviteError().message);
    }
    clock.advance(7 * DAY);
    await expect(previewInvite(ctx, hasher, web, issued.token)).rejects.toBeInstanceOf(
      InvalidInviteError,
    );
    expect(
      (await listInvites(ctx, deploymentAdmin, { status: 'expired' })).map((i) => i.id),
    ).toEqual([issued.invite.id]);
    // Nothing was written by those reads: still stored as pending.
    expect((await store.invites.get(issued.invite.id))?.status).toBe('pending');
  });

  it('only the web handshake (deployment-wide) redeems a link', async () => {
    const issued = await invite();
    const key: Principal = { spaceId: 'blog', kind: 'cma', scopes: scopesForKind('cma') };
    await expect(previewInvite(ctx, hasher, key, issued.token)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      acceptInvite(ctx, hasher, key, issued.token, { subject: 'u', email: 'grace@example.com' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a resend rotates the token: the old link stops working', async () => {
    const first = await invite();
    clock.advance(6 * DAY);
    const again = await resendInvite(
      ctx,
      hasher,
      deploymentAdmin,
      first.invite.id,
      {},
      { origin: ORIGIN },
    );
    expect(again.token).not.toBe(first.token);
    expect(again.invite.sendCount).toBe(2);
    expect(Date.parse(again.invite.expiresAt) - clock.now().getTime()).toBe(7 * DAY);
    await expect(previewInvite(ctx, hasher, web, first.token)).rejects.toBeInstanceOf(
      InvalidInviteError,
    );
    await expect(previewInvite(ctx, hasher, web, again.token)).resolves.toBeTruthy();
  });

  it('a revoke ends it; an accepted one can be neither revoked nor resent', async () => {
    const issued = await invite();
    const revoked = await revokeInvite(ctx, deploymentAdmin, issued.invite.id);
    expect(revoked).toMatchObject({ status: 'revoked', revokedBy: { id: 'usr_ada' } });
    await expect(previewInvite(ctx, hasher, web, issued.token)).rejects.toBeInstanceOf(
      InvalidInviteError,
    );
    await expect(
      resendInvite(ctx, hasher, deploymentAdmin, issued.invite.id),
    ).rejects.toBeInstanceOf(InvalidStateError);
    const second = await invite();
    await acceptInvite(ctx, hasher, web, second.token, {
      subject: 'usr_g',
      email: 'grace@example.com',
    });
    await expect(revokeInvite(ctx, deploymentAdmin, second.invite.id)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  it('keeps an existing team member’s role, and skips a deleted role', async () => {
    await addMember(ctx, 'blog', { email: 'grace@example.com', role: 'admin' });
    const role = await createRole(ctx, 'docs', { name: 'Temp', scopes: [SCOPES.previewRead] });
    const issued = await invite({
      grants: [
        { space: 'blog', role: 'viewer' },
        { space: 'docs', role: role.id },
      ],
    });
    await store.roles.delete('docs', role.id);
    const accepted = await acceptInvite(ctx, hasher, web, issued.token, {
      subject: 'usr_g',
      email: 'grace@example.com',
    });
    expect(accepted.grants.map((g) => g.outcome)).toEqual(['already_member', 'role_missing']);
    expect(await store.members.getByEmail('docs', 'grace@example.com')).toBeNull();
  });

  describe('emailing the link (the engine)', () => {
    const due = () =>
      store.allEvents().filter((e): e is InviteEmailDueEvent => e.type === 'invite.email_due');

    it('mints its own token, records only its hash, and sends once on redelivery', async () => {
      const issued = await invite();
      const email = new RecordingEmailSender();
      const event = due()[0] as InviteEmailDueEvent;
      expect(await deliverInviteEmail(ctx, { email, hasher }, event)).toBe('sent');
      expect(await deliverInviteEmail(ctx, { email, hasher }, event)).toBe('already_sent');
      expect(email.sent).toHaveLength(1);
      const link = /https:\/\/admin\.example\.com\/invite\/(cwi_\S+)/.exec(
        email.sent[0]?.text ?? '',
      )?.[1];
      expect(link && link !== issued.token).toBe(true);
      expect(email.sent[0]?.to).toEqual(['grace@example.com']);
      const stored = await store.invites.get(issued.invite.id);
      expect(stored?.emailTokenHash).toBe(hasher.hash(link as string));
      expect(JSON.stringify(stored)).not.toContain(link as string);
      // Either link opens the invitation.
      await expect(previewInvite(ctx, hasher, web, link as string)).resolves.toBeTruthy();
      await expect(previewInvite(ctx, hasher, web, issued.token)).resolves.toBeTruthy();
    });

    it('sends nothing for a stale event (resent or revoked since), and drops it without email', async () => {
      const issued = await invite();
      const first = due()[0] as InviteEmailDueEvent;
      await resendInvite(ctx, hasher, deploymentAdmin, issued.invite.id, {}, { origin: ORIGIN });
      const email = new RecordingEmailSender();
      expect(await deliverInviteEmail(ctx, { email, hasher }, first)).toBe('stale');
      await revokeInvite(ctx, deploymentAdmin, issued.invite.id);
      expect(
        await deliverInviteEmail(ctx, { email, hasher }, due()[1] as InviteEmailDueEvent),
      ).toBe('stale');
      expect(email.sent).toHaveLength(0);
      // Without Email Sending the consumer drops it, and no webhook or live event goes out.
      const sender = { send: async () => ({ delivered: true }) } as never;
      await expect(consumeEvent(ctx, { sender }, first)).resolves.toEqual([]);
    });

    it('throws when the send fails, so the queue retries with a fresh link', async () => {
      await invite();
      const event = due()[0] as InviteEmailDueEvent;
      const failing = new RecordingEmailSender({ delivered: false, error: 'bounced' });
      await expect(deliverInviteEmail(ctx, { email: failing, hasher }, event)).rejects.toThrow(
        /bounced/,
      );
      const ok = new RecordingEmailSender();
      expect(await deliverInviteEmail(ctx, { email: ok, hasher }, event)).toBe('sent');
    });
  });
});
