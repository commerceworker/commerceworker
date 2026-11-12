import {
  hashShopperCode,
  hashShopperSecret,
  SHOPPER_CODE_TTL_MS,
  SHOPPER_COOLDOWN_MS,
  SHOPPER_DAILY_MAX,
  SHOPPER_DAY_MS,
  SHOPPER_LOCKOUT_MS,
  SHOPPER_MAX_ATTEMPTS,
  SHOPPER_SESSION_TTL_MS,
  SHOPPER_TOUCH_MS,
  shopperSignInEmail,
} from '@commerceworker/core';
import { RecordingEmailSender } from '@commerceworker/test-kit';
import { InMemoryShopperAuth } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  pruneShopperAuth,
  redeemShopperCode,
  redeemShopperLink,
  type ShopperStartPorts,
  shopperLinkPreview,
  shopperSession,
  shopperSignOut,
  startShopperSignIn,
} from '../src/commerce';

const now = 1_800_000_000_000;
const ORIGIN = 'https://shop.example';
const KEY = 'k'.repeat(64);

/** `null` for a deployment with no Email Sending. */
function setup(sender: RecordingEmailSender | null = new RecordingEmailSender()) {
  const shoppers = new InMemoryShopperAuth();
  const email = sender ?? new RecordingEmailSender();
  const ports: ShopperStartPorts = {
    shoppers,
    codeKey: KEY,
    email: sender ?? undefined,
    storefrontOrigin: ORIGIN,
  };
  return { shoppers, ports, email };
}

/** The code and the link token out of the one message sent. */
function mailed(email: RecordingEmailSender, n = email.sent.length - 1) {
  const text = email.sent[n]!.text!;
  return {
    code: /code is (\d{6})/.exec(text)![1]!,
    token: /\/account\/confirm\/([0-9a-f]{64})/.exec(text)![1]!,
  };
}

describe('asking for a code', () => {
  it('mails a six-digit code and a link, and keeps only hashes of them', async () => {
    const { ports, email, shoppers } = setup();
    expect(await startShopperSignIn(ports, '  Pat@Example.com ', now)).toEqual({ status: 'sent' });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.to).toEqual(['pat@example.com']);
    const { code, token } = mailed(email);
    const [row] = shoppers.stored().signIns;
    expect(row).toMatchObject({
      email: 'pat@example.com',
      expiresAt: now + SHOPPER_CODE_TTL_MS,
      attempts: 0,
    });
    expect(row!.codeHash).toBe(await hashShopperCode(KEY, 'pat@example.com', code));
    expect(row!.linkHash).toBe(await hashShopperSecret(token));
    // Neither the code nor the token is in what is stored.
    const stored = JSON.stringify(shoppers.stored());
    expect(stored).not.toContain(token);
    expect(stored).not.toMatch(new RegExp(`"${code}"`));
  });

  it('answers the same for an address with orders and one without: it never looks', async () => {
    // The ports have no orders to read; two addresses get one answer and one message each.
    const { ports, email } = setup();
    const a = await startShopperSignIn(ports, 'has-orders@example.com', now);
    const b = await startShopperSignIn(ports, 'never-ordered@example.com', now);
    expect(a).toEqual(b);
    expect(email.sent.map((m) => m.subject)).toEqual([
      email.sent[0]!.subject,
      email.sent[0]!.subject,
    ]);
  });

  it('refuses what is not an address, and says so without sending', async () => {
    const { ports, email } = setup();
    for (const bad of ['', 'nope', 'a@b', 'x'.repeat(250) + '@example.com', null, 5, { a: 1 }])
      expect(await startShopperSignIn(ports, bad, now)).toEqual({ status: 'invalid' });
    expect(email.sent).toHaveLength(0);
  });

  it('says so when the deployment can’t send, and keeps nothing', async () => {
    const { ports, shoppers } = setup(null);
    expect(await startShopperSignIn(ports, 'pat@example.com', now)).toEqual({
      status: 'unavailable',
    });
    expect(shoppers.stored().signIns).toHaveLength(0);
  });

  it('sends at most one code a minute, and the old one still works until a new one is sent', async () => {
    const { ports, email } = setup();
    await startShopperSignIn(ports, 'pat@example.com', now);
    expect(
      await startShopperSignIn(ports, 'pat@example.com', now + SHOPPER_COOLDOWN_MS - 1),
    ).toEqual({
      status: 'wait',
    });
    expect(email.sent).toHaveLength(1);
    const first = mailed(email);
    expect(await startShopperSignIn(ports, 'pat@example.com', now + SHOPPER_COOLDOWN_MS)).toEqual({
      status: 'sent',
    });
    // Asking again ended the first: its code and link are dead.
    const at = now + SHOPPER_COOLDOWN_MS + 1;
    expect(await redeemShopperCode(ports, 'pat@example.com', first.code, at)).toBeNull();
    expect(await redeemShopperLink(ports, first.token, at)).toBeNull();
    const second = mailed(email);
    expect(await redeemShopperCode(ports, 'pat@example.com', second.code, at)).not.toBeNull();
  });

  it('reports a message Email Sending refused or threw on, and keeps the cooldown', async () => {
    const refused = setup(new RecordingEmailSender({ delivered: false, error: 'no' }));
    expect(await startShopperSignIn(refused.ports, 'pat@example.com', now)).toEqual({
      status: 'failed',
    });
    const threw = setup();
    threw.ports = {
      ...threw.ports,
      email: {
        send: async () => {
          throw new Error('boom');
        },
      },
    };
    expect(await startShopperSignIn(threw.ports, 'pat@example.com', now)).toEqual({
      status: 'failed',
    });
  });

  it('escapes everything the HTML part carries', () => {
    const hostile = 'https://shop.example/account/confirm/"><script>alert(1)</script>&x=1';
    const mail = shopperSignInEmail('123456', hostile);
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;x=1');
    // The subject holds neither the code nor the link.
    expect(mail.subject).not.toMatch(/\d{6}|https/);
    const hostileCode = shopperSignInEmail('<b>1</b>', 'https://x.test');
    expect(hostileCode.html).not.toContain('<b>');
  });
});

describe('redeeming a code', () => {
  it('signs the address in once, and a session secret is stored only as its hash', async () => {
    const { ports, email, shoppers } = setup();
    await startShopperSignIn(ports, 'pat@example.com', now);
    const { code } = mailed(email);
    const signedIn = await redeemShopperCode(ports, 'PAT@example.com', code, now + 1000);
    expect(signedIn).toMatchObject({
      email: 'pat@example.com',
      expiresAt: now + 1000 + SHOPPER_SESSION_TTL_MS,
    });
    expect(signedIn!.secret).toMatch(/^[0-9a-f]{64}$/);
    const [s] = shoppers.stored().sessions;
    expect(s!.tokenHash).toBe(await hashShopperSecret(signedIn!.secret));
    expect(JSON.stringify(shoppers.stored())).not.toContain(signedIn!.secret);
    // The code is spent.
    expect(await redeemShopperCode(ports, 'pat@example.com', code, now + 2000)).toBeNull();
  });

  it('refuses a wrong code, another address’s code, an expired one and malformed input alike', async () => {
    const { ports, email } = setup();
    await startShopperSignIn(ports, 'pat@example.com', now);
    await startShopperSignIn(ports, 'sam@example.com', now);
    const pat = mailed(email, 0);
    const sam = mailed(email, 1);
    const wrong = pat.code === '000000' ? '000001' : '000000';
    expect(await redeemShopperCode(ports, 'pat@example.com', wrong, now + 1)).toBeNull();
    // Sam's code isn't Pat's, even from the same table.
    if (sam.code !== pat.code)
      expect(await redeemShopperCode(ports, 'pat@example.com', sam.code, now + 1)).toBeNull();
    expect(
      await redeemShopperCode(ports, 'pat@example.com', pat.code, now + SHOPPER_CODE_TTL_MS),
    ).toBeNull();
    for (const bad of ['12345', '1234567', 'abcdef', '', ' 123456', null, 123456])
      expect(await redeemShopperCode(ports, 'pat@example.com', bad, now + 1)).toBeNull();
    expect(await redeemShopperCode(ports, 'nobody@example.com', '123456', now + 1)).toBeNull();
    expect(await redeemShopperCode(ports, 'not an address', '123456', now + 1)).toBeNull();
    // None of that spent Pat's code: it works inside its time.
    expect(await redeemShopperCode(ports, 'pat@example.com', pat.code, now + 2)).not.toBeNull();
  });

  it('locks the code on the fifth wrong try, the right one after it too, and waits out the lockout from the last try before sending another', async () => {
    const { ports, email } = setup();
    await startShopperSignIn(ports, 'pat@example.com', now);
    const { code } = mailed(email);
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < SHOPPER_MAX_ATTEMPTS; i++)
      expect(await redeemShopperCode(ports, 'pat@example.com', wrong, now + 1)).toBeNull();
    expect(await redeemShopperCode(ports, 'pat@example.com', code, now + 2)).toBeNull();
    expect(
      await startShopperSignIn(ports, 'pat@example.com', now + SHOPPER_COOLDOWN_MS * 2),
    ).toEqual({
      status: 'wait',
    });
    expect(await startShopperSignIn(ports, 'pat@example.com', now + SHOPPER_LOCKOUT_MS)).toEqual({
      status: 'wait',
    });
    expect(
      await startShopperSignIn(ports, 'pat@example.com', now + 1 + SHOPPER_LOCKOUT_MS),
    ).toEqual({
      status: 'sent',
    });
  });

  it('counts failures across codes: four wrong tries, a new code, and one more try spends the address', async () => {
    const { ports, email } = setup();
    const wrongFor = (c: string) => (c === '000000' ? '000001' : '000000');
    await startShopperSignIn(ports, 'pat@example.com', now);
    const first = mailed(email);
    for (let i = 0; i < SHOPPER_MAX_ATTEMPTS - 1; i++)
      expect(
        await redeemShopperCode(ports, 'pat@example.com', wrongFor(first.code), now + 1),
      ).toBeNull();
    // A minute on, a new code: the four failures went with the address.
    const at = now + SHOPPER_COOLDOWN_MS;
    expect(await startShopperSignIn(ports, 'pat@example.com', at)).toEqual({ status: 'sent' });
    const second = mailed(email);
    const bad = wrongFor(second.code);
    // Four more wrong tries: the first is the fifth failure, the rest find nothing to try.
    for (let i = 0; i < 4; i++)
      expect(await redeemShopperCode(ports, 'pat@example.com', bad, at + 1 + i)).toBeNull();
    // So even the right code is refused, and asking again waits fifteen minutes from the last try.
    expect(await redeemShopperCode(ports, 'pat@example.com', second.code, at + 10)).toBeNull();
    expect(
      await startShopperSignIn(ports, 'pat@example.com', at + 2 * SHOPPER_COOLDOWN_MS),
    ).toEqual({
      status: 'wait',
    });
    // At most five failures an address a window, whatever the codes: 4 + 1, not 4 + 4.
    expect(await startShopperSignIn(ports, 'pat@example.com', at + 4 + SHOPPER_LOCKOUT_MS)).toEqual(
      {
        status: 'sent',
      },
    );
  });

  it('still lets the emailed link in after five wrong codes: the lock gates the code and asking again, not the link', async () => {
    const { ports, email } = setup();
    await startShopperSignIn(ports, 'pat@example.com', now);
    const { code, token } = mailed(email);
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < SHOPPER_MAX_ATTEMPTS; i++)
      await redeemShopperCode(ports, 'pat@example.com', wrong, now + 1);
    expect(await redeemShopperCode(ports, 'pat@example.com', code, now + 2)).toBeNull();
    expect(await startShopperSignIn(ports, 'pat@example.com', now + SHOPPER_COOLDOWN_MS)).toEqual({
      status: 'wait',
    });
    expect((await redeemShopperLink(ports, token, now + 3))?.email).toBe('pat@example.com');
  });

  it('sends an address at most twenty codes a day', async () => {
    const { ports, email } = setup();
    for (let i = 0; i < SHOPPER_DAILY_MAX; i++)
      expect(
        await startShopperSignIn(ports, 'pat@example.com', now + i * SHOPPER_COOLDOWN_MS),
      ).toEqual({
        status: 'sent',
      });
    const next = now + SHOPPER_DAILY_MAX * SHOPPER_COOLDOWN_MS;
    expect(await startShopperSignIn(ports, 'pat@example.com', next)).toEqual({ status: 'wait' });
    expect(email.sent).toHaveLength(SHOPPER_DAILY_MAX);
    // Another address is unaffected, and the day ends.
    expect(await startShopperSignIn(ports, 'sam@example.com', next)).toEqual({ status: 'sent' });
    expect(await startShopperSignIn(ports, 'pat@example.com', now + SHOPPER_DAY_MS)).toEqual({
      status: 'sent',
    });
  });

  it('lets one of many simultaneous redemptions of a code win', async () => {
    const { ports, email, shoppers } = setup();
    await startShopperSignIn(ports, 'pat@example.com', now);
    const { code } = mailed(email);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => redeemShopperCode(ports, 'pat@example.com', code, now + 1)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(shoppers.stored().sessions).toHaveLength(1);
  });
});

describe('redeeming a link', () => {
  it('signs the address in once, with the code dead after it', async () => {
    const { ports, email, shoppers } = setup();
    await startShopperSignIn(ports, 'pat@example.com', now);
    const { code, token } = mailed(email);
    const signedIn = await redeemShopperLink(ports, token, now + 1);
    expect(signedIn?.email).toBe('pat@example.com');
    expect(await redeemShopperLink(ports, token, now + 2)).toBeNull();
    expect(await redeemShopperCode(ports, 'pat@example.com', code, now + 3)).toBeNull();
    expect(shoppers.stored().sessions).toHaveLength(1);
  });

  it('and the code works once instead when it is the code that is used first', async () => {
    const { ports, email } = setup();
    await startShopperSignIn(ports, 'pat@example.com', now);
    const { code, token } = mailed(email);
    expect(await redeemShopperCode(ports, 'pat@example.com', code, now + 1)).not.toBeNull();
    expect(await redeemShopperLink(ports, token, now + 2)).toBeNull();
  });

  it('refuses an expired, unknown or malformed token, and a hash presented as one', async () => {
    const { ports, email } = setup();
    await startShopperSignIn(ports, 'pat@example.com', now);
    const { token } = mailed(email);
    expect(await redeemShopperLink(ports, token, now + SHOPPER_CODE_TTL_MS)).toBeNull();
    expect(await redeemShopperLink(ports, 'f'.repeat(64), now + 1)).toBeNull();
    expect(await redeemShopperLink(ports, token.slice(1), now + 1)).toBeNull();
    expect(await redeemShopperLink(ports, null, now + 1)).toBeNull();
    // What is stored is the token's hash: presenting it finds nothing.
    expect(await redeemShopperLink(ports, await hashShopperSecret(token), now + 1)).toBeNull();
    expect(await redeemShopperLink(ports, token, now + 2)).not.toBeNull();
  });

  it('lets one of many simultaneous redemptions of a link win', async () => {
    const { ports, email, shoppers } = setup();
    await startShopperSignIn(ports, 'pat@example.com', now);
    const { token } = mailed(email);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => redeemShopperLink(ports, token, now + 1)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(shoppers.stored().sessions).toHaveLength(1);
  });
});

describe('previewing a link', () => {
  it('shows who it is for, masked, and uses nothing up', async () => {
    const { ports, email, shoppers } = setup();
    await startShopperSignIn(ports, 'pat@example.com', now);
    const { token } = mailed(email);
    for (let i = 0; i < 3; i++)
      expect(await shopperLinkPreview(ports, token, now + 1)).toEqual({
        masked: 'p***@example.com',
      });
    expect(shoppers.stored().sessions).toHaveLength(0);
    // Still good to redeem; and once spent, expired, unknown or malformed it shows nothing.
    expect(await redeemShopperLink(ports, token, now + 2)).not.toBeNull();
    expect(await shopperLinkPreview(ports, token, now + 3)).toBeNull();
    expect(await shopperLinkPreview(ports, 'f'.repeat(64), now + 3)).toBeNull();
    expect(await shopperLinkPreview(ports, 'x', now + 3)).toBeNull();
    expect(await shopperLinkPreview(ports, null, now + 3)).toBeNull();
  });
});

describe('a session', () => {
  async function signedIn() {
    const s = setup();
    await startShopperSignIn(s.ports, 'pat@example.com', now);
    const out = (await redeemShopperLink(s.ports, mailed(s.email).token, now + 1))!;
    return { ...s, out, hash: await hashShopperSecret(out.secret) };
  }

  it('says who is signed in, until it expires', async () => {
    const { ports, out, hash } = await signedIn();
    expect(await shopperSession(ports, hash, now + 5)).toEqual({
      email: 'pat@example.com',
      since: now + 1,
      expiresAt: out.expiresAt,
    });
    expect(await shopperSession(ports, hash, out.expiresAt)).toBeNull();
    expect(await shopperSession(ports, 'e'.repeat(64), now + 5)).toBeNull();
  });

  it('records its use at most hourly, and does not extend it', async () => {
    const { ports, shoppers, out, hash } = await signedIn();
    await shopperSession(ports, hash, now + 10);
    expect(shoppers.stored().sessions[0]!.lastSeenAt).toBe(now + 10);
    await shopperSession(ports, hash, now + 20);
    expect(shoppers.stored().sessions[0]!.lastSeenAt).toBe(now + 10);
    await shopperSession(ports, hash, now + 10 + SHOPPER_TOUCH_MS + 1);
    expect(shoppers.stored().sessions[0]!.lastSeenAt).toBe(now + 10 + SHOPPER_TOUCH_MS + 1);
    expect(shoppers.stored().sessions[0]!.expiresAt).toBe(out.expiresAt);
  });

  it('ends at sign-out, and signing out twice is no harm', async () => {
    const { ports, hash } = await signedIn();
    await shopperSignOut(ports, hash);
    expect(await shopperSession(ports, hash, now + 5)).toBeNull();
    await expect(shopperSignOut(ports, hash)).resolves.toBeUndefined();
  });

  it('is found by the secret’s hash, so the secret itself opens nothing', async () => {
    const { ports, out, hash } = await signedIn();
    // The use-case takes a hash; the secret itself is no key into the table.
    expect(await shopperSession(ports, out.secret, now + 5)).toBeNull();
    expect(await shopperSession(ports, hash, now + 5)).not.toBeNull();
  });
});

describe('the sweep', () => {
  it('deletes expired sessions, and sign-ins a day after they expire', async () => {
    const { ports, email, shoppers } = setup();
    await startShopperSignIn(ports, 'pat@example.com', now);
    const out = (await redeemShopperLink(ports, mailed(email).token, now + 1))!;
    expect(out).not.toBeNull();
    // Expired but inside the day: the row holds the cooldown, the carried tries and the daily count.
    for (const at of [SHOPPER_CODE_TTL_MS + 1, SHOPPER_CODE_TTL_MS + SHOPPER_LOCKOUT_MS + 1])
      expect(await pruneShopperAuth(ports, now + at)).toEqual({ signIns: 0, sessions: 0 });
    expect(await pruneShopperAuth(ports, now + SHOPPER_CODE_TTL_MS + SHOPPER_DAY_MS + 1)).toEqual({
      signIns: 1,
      sessions: 0,
    });
    expect(await pruneShopperAuth(ports, out.expiresAt + 1)).toEqual({ signIns: 0, sessions: 1 });
    expect(shoppers.stored()).toEqual({ signIns: [], sessions: [] });
  });
});
