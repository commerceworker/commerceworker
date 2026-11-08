import type { MemberInvite, SpaceMember } from '@commerceworker/domain';
import { type ContentStore, TransactionConflictError } from '@commerceworker/ports';
import { InMemoryContentStore } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

// Invitations on D1 (migration 0019), held to the same contract as the in-memory store the
// application tests use. The file shares one database: each test makes its own ids and addresses.
const stores: [string, () => ContentStore][] = [
  ['D1', () => createD1Store(testDb)],
  ['in-memory', () => new InMemoryContentStore()],
];

const NOW = new Date('2026-11-01T10:00:00.000Z');
const DAY = 86_400_000;

function makeInvite(over: Partial<MemberInvite> = {}): MemberInvite {
  const id = crypto.randomUUID();
  return {
    id,
    email: `${id}@example.com`,
    role: 'member',
    grants: [{ spaceId: 'blog', roleId: 'r-editor' }],
    tokenHash: `hash-${id}`,
    status: 'pending',
    expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
    version: 1,
    invitedBy: { kind: 'user', id: 'usr_ada' },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    sentAt: NOW.toISOString(),
    sendCount: 1,
    ...over,
  };
}

const member = (invite: MemberInvite, subject: string): SpaceMember => ({
  id: crypto.randomUUID(),
  spaceId: `space-${invite.id}`,
  email: invite.email,
  subject,
  roleId: 'r-editor',
  disabled: false,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
});

describe.each(stores)('member invites (%s)', (_name, make) => {
  it('round-trips an invitation and finds it by either token hash', async () => {
    const store = make();
    const invite = makeInvite({ role: 'admin' });
    await store.invites.create(invite);
    expect(await store.invites.get(invite.id)).toEqual(invite);
    expect((await store.invites.findByTokenHash(invite.tokenHash))?.id).toBe(invite.id);
    expect(await store.invites.findByTokenHash('hash-nothing')).toBeNull();

    expect(await store.invites.recordEmailToken(invite.id, 1, `emailed-${invite.id}`, null)).toBe(
      true,
    );
    expect((await store.invites.findByTokenHash(`emailed-${invite.id}`))?.id).toBe(invite.id);
    expect((await store.invites.get(invite.id))?.emailedAt).toBeUndefined();
    const at = new Date(NOW.getTime() + 1000).toISOString();
    expect(await store.invites.recordEmailToken(invite.id, 1, `emailed-${invite.id}`, at)).toBe(
      true,
    );
    expect((await store.invites.get(invite.id))?.emailedAt).toBe(at);
    // A stale version records nothing.
    expect(await store.invites.recordEmailToken(invite.id, 7, 'x', at)).toBe(false);
  });

  it('lists newest first by status, reading expiry as of now without writing it', async () => {
    const store = make();
    const email = `${crypto.randomUUID()}@example.com`;
    const live = makeInvite({ email, createdAt: new Date(NOW.getTime() + 2).toISOString() });
    const old = makeInvite({
      email,
      expiresAt: new Date(NOW.getTime() - 1).toISOString(),
      createdAt: new Date(NOW.getTime() + 1).toISOString(),
    });
    await store.invites.create(old);
    await store.invites.create(live);
    const ids = async (status?: 'pending' | 'expired') =>
      (await store.invites.list({ now: NOW, email, ...(status ? { status } : {}) })).map(
        (i) => i.id,
      );
    expect(await ids()).toEqual([live.id, old.id]);
    expect(await ids('pending')).toEqual([live.id]);
    expect(await ids('expired')).toEqual([old.id]);
    expect((await store.invites.get(old.id))?.status).toBe('pending');
  });

  it('replaces only at the expected version, directly and inside a unit of work', async () => {
    const store = make();
    const invite = makeInvite();
    await store.invites.create(invite);
    const revoked: MemberInvite = {
      ...invite,
      status: 'revoked',
      version: 2,
      revokedAt: NOW.toISOString(),
      revokedBy: { kind: 'admin', id: 'admin-token' },
    };
    await store.invites.replace(revoked, 1);
    expect(await store.invites.get(invite.id)).toEqual(revoked);
    await expect(store.invites.replace({ ...revoked, version: 3 }, 1)).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
  });

  it('consumes a link with its team grants atomically: a lost race writes nothing', async () => {
    const store = make();
    const invite = makeInvite();
    await store.invites.create(invite);
    const accepted = (by: string): MemberInvite => ({
      ...invite,
      status: 'accepted',
      version: 2,
      acceptedAt: NOW.toISOString(),
      acceptedBy: by,
    });
    // Two accepts read version 1; the first commits.
    await store.withTransaction(async (tx) => {
      await tx.invites.replace(accepted('usr_1'), 1);
      await tx.members.save(member(invite, 'usr_1'));
    });
    const loser = member(invite, 'usr_2');
    await expect(
      store.withTransaction(async (tx) => {
        await tx.invites.replace(accepted('usr_2'), 1);
        await tx.members.save({ ...loser, spaceId: `other-${invite.id}` });
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect((await store.invites.get(invite.id))?.acceptedBy).toBe('usr_1');
    expect(await store.members.list(`other-${invite.id}`)).toEqual([]);
    expect((await store.members.list(`space-${invite.id}`)).map((m) => m.subject)).toEqual([
      'usr_1',
    ]);
  });

  it('refuses a second invitation with the same token hash', async () => {
    const store = make();
    const invite = makeInvite();
    await store.invites.create(invite);
    if (store instanceof InMemoryContentStore) return; // the unique index is the adapter's
    await expect(
      store.invites.create(makeInvite({ tokenHash: invite.tokenHash })),
    ).rejects.toThrow();
  });
});
