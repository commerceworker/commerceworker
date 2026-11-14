import { InMemoryPasskeyStore } from '@commerceworker/test-kit/commerce';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));
let store: InMemoryPasskeyStore;
const people: Record<
  string,
  { id: string; email: string; name: string; role: string; disabledAt: number | null }
> = {
  usr_ada: {
    id: 'usr_ada',
    email: 'ada@example.com',
    name: 'Ada',
    role: 'admin',
    disabledAt: null,
  },
};
vi.mock('~/lib/wire.server', () => ({ adminPasskeys: () => store }));
const audit = vi.fn();
vi.mock('~/lib/audit.server', () => ({ audit, clientIp: () => '203.0.113.7' }));
const recordFailure = vi.fn();
vi.mock('~/lib/auth.server', () => ({
  recordFailure,
  waitFor: async () => 0,
  startSession: async (_r: Request, id: string) => `session-for-${id}`,
  Throttled: class extends Error {},
}));
class TeamError extends Error {}
vi.mock('~/lib/team.server', () => ({ TeamError }));
vi.mock('~/lib/two-factor.server', () => ({
  confirmPassword: async (by: { id: string }, given: string) => {
    if (given !== 'right') throw new TeamError('Your password is not right.');
    return people[by.id];
  },
}));
const verifyAuthenticationResponse = vi.fn();
const verifyRegistrationResponse = vi.fn();
vi.mock('@simplewebauthn/server', async (actual) => ({
  ...(await actual<typeof import('@simplewebauthn/server')>()),
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
}));

const {
  addPasskey,
  removePasskey,
  signInOptions,
  signInWithPasskey,
  registrationOptions,
  listPasskeys,
} = await import('~/lib/passkeys.server');
const req = () => new Request('https://acme.commerceworker.com/login/passkey', { method: 'POST' });
const ada = {
  kind: 'user' as const,
  id: 'usr_ada',
  name: 'Ada',
  email: 'ada@example.com',
  role: 'admin' as const,
};
const answer = { id: 'cred_1' } as Parameters<typeof signInWithPasskey>[2];
const tokenOf = (cookie: string) => /__Host-cw_pk=([^;]+)/.exec(cookie)![1];

describe('passkeys', () => {
  beforeEach(async () => {
    store = new InMemoryPasskeyStore({ users: Object.values(people) });
    await store.add({
      id: 'cred_1',
      userId: 'usr_ada',
      publicKey: 'AQID',
      counter: 1,
      transports: [],
      backedUp: false,
      createdAt: 1,
      lastUsedAt: null,
      name: 'Laptop',
    });
    people.usr_ada!.disabledAt = null;
    audit.mockReset();
    recordFailure.mockReset();
    verifyAuthenticationResponse.mockReset();
    verifyRegistrationResponse.mockReset();
  });

  it('signs in once per challenge, checking the answer against this host', async () => {
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    });
    const { options, cookie } = await signInOptions(req());
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const token = tokenOf(cookie);
    expect(await signInWithPasskey(req(), token, answer)).toBe('session-for-usr_ada');
    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: options.challenge,
        expectedOrigin: 'https://acme.commerceworker.com',
        expectedRPID: 'acme.commerceworker.com',
        requireUserVerification: true,
      }),
    );
    expect((await store.withUser('cred_1'))?.passkey.counter).toBe(2);
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'auth.sign_in', {
      actor: expect.objectContaining({ id: 'usr_ada' }),
      detail: { method: 'passkey' },
    });
    // The same challenge can't be answered twice.
    expect(await signInWithPasskey(req(), token, answer)).toBeNull();
  });

  it('refuses an unknown passkey, a disabled person and an answer that does not verify', async () => {
    const tryWith = async (a = answer) =>
      signInWithPasskey(req(), tokenOf((await signInOptions(req())).cookie), a);
    expect(await tryWith({ id: 'cred_nope' } as typeof answer)).toBeNull();
    people.usr_ada!.disabledAt = 1;
    expect(await tryWith()).toBeNull();
    people.usr_ada!.disabledAt = null;
    verifyAuthenticationResponse.mockRejectedValueOnce(new Error('counter went backwards'));
    expect(await tryWith()).toBeNull();
    expect(recordFailure).toHaveBeenCalledTimes(3);
    expect(verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
  });

  it('adds a passkey only after the password, and only against its own challenge', async () => {
    await expect(registrationOptions(req(), ada, 'wrong')).rejects.toThrow(/password/);
    await expect(addPasskey(req(), ada, {} as never, 'Phone')).rejects.toThrow(/too long/);
    await registrationOptions(req(), ada, 'right');
    verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred_2',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
        credentialBackedUp: true,
      },
    });
    await addPasskey(req(), ada, {} as never, '  Phone  ');
    expect((await store.withUser('cred_2'))?.passkey).toMatchObject({
      userId: 'usr_ada',
      name: 'Phone',
      publicKey: 'AQID',
    });
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'auth.passkey_added', {
      actor: ada,
      detail: { name: 'Phone' },
    });
  });

  it('lists only display fields and excludes existing credentials when registering', async () => {
    expect(await listPasskeys(ada.id)).toEqual([
      {
        id: 'cred_1',
        name: 'Laptop',
        backedUp: false,
        createdAt: 1,
        lastUsedAt: null,
      },
    ]);
    const options = await registrationOptions(req(), ada, 'right');
    expect(options.excludeCredentials).toEqual([
      { id: 'cred_1', transports: [], type: 'public-key' },
    ]);
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
  });

  it('removes only your own passkey, after the password', async () => {
    await expect(removePasskey(req(), ada, 'cred_1', 'wrong')).rejects.toThrow(/password/);
    await expect(
      removePasskey(req(), { ...ada, id: 'usr_bob' }, 'cred_1', 'right'),
    ).rejects.toThrow();
    await removePasskey(req(), ada, 'cred_1', 'right');
    expect(await store.withUser('cred_1')).toBeUndefined();
  });
});
