/**
 * The behaviour every `ShopperAuth` keeps: the in-memory store runs it in node and the D1 store in
 * workerd (packages/db). Addresses end `@shopper.test`, which the D1 runner clears before each case.
 */
import type { ShopperAuth, ShopperSignInLimits } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';

const now = 1_000_000;
const limits: ShopperSignInLimits = {
  cooldownMs: 60_000,
  lockoutMs: 900_000,
  maxAttempts: 3,
  dailyMax: 4,
  dayMs: 86_400_000,
};
const h = (c: string) => c.repeat(64).slice(0, 64);
/** A sign-in's link hash, distinct from its code hash `h(c)`. */
const link = (c: string) => `link-${c}`.padEnd(64, '0');
const signIn = (email: string, at = now, c = 'a') => ({
  email,
  codeHash: h(c),
  linkHash: link(c),
  createdAt: at,
  expiresAt: at + 600_000,
});

export function describeShopperAuthContract(name: string, make: () => Promise<ShopperAuth>) {
  describe(`${name}: the shopper sign-in contract`, () => {
    it('issues one live sign-in per address and replaces it when asked again after the cooldown', async () => {
      const auth = await make();
      expect(await auth.issueSignIn(signIn('a@shopper.test', now, 'a'), limits)).toBe(true);
      // Within the cooldown: refused, and the first is untouched.
      expect(await auth.issueSignIn(signIn('a@shopper.test', now + 59_999, 'c'), limits)).toBe(
        false,
      );
      expect(await auth.spendAttempt('a@shopper.test', now + 1, 3)).toBe(h('a'));
      // After it: replaced, so the old link and code are dead (the try already made goes with the address).
      const next = signIn('a@shopper.test', now + 60_000, 'c');
      expect(await auth.issueSignIn(next, limits)).toBe(true);
      expect(await auth.consumeLink(link('a'), now + 60_001)).toBeNull();
      expect(await auth.consumeCode('a@shopper.test', h('a'), now + 60_001)).toBe(false);
      expect(await auth.spendAttempt('a@shopper.test', now + 60_001, 3)).toBe(h('c'));
      expect(await auth.linkEmail(link('c'), now + 60_002)).toBe('a@shopper.test');
      expect(await auth.consumeLink(link('c'), now + 60_002)).toBe('a@shopper.test');
    });

    it('keeps addresses apart', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('b1@shopper.test', now, 'a'), limits);
      await auth.issueSignIn(signIn('b2@shopper.test', now, 'b'), limits);
      expect(await auth.consumeCode('b1@shopper.test', h('b'), now + 1)).toBe(false);
      expect(await auth.consumeCode('b1@shopper.test', h('a'), now + 1)).toBe(true);
      expect(await auth.spendAttempt('b2@shopper.test', now + 1, 3)).toBe(h('b'));
    });

    it('counts every try and stops handing out the hash at the cap', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('c@shopper.test'), limits);
      for (let i = 0; i < 3; i++)
        expect(await auth.spendAttempt('c@shopper.test', now + 1, 3)).toBe(h('a'));
      expect(await auth.spendAttempt('c@shopper.test', now + 1, 3)).toBeNull();
      expect(await auth.spendAttempt('nobody@shopper.test', now + 1, 3)).toBeNull();
    });

    it('refuses a new sign-in while an address that spent its attempts is locked out, from its last try', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('d@shopper.test'), limits);
      for (let i = 0; i < 3; i++) await auth.spendAttempt('d@shopper.test', now + 1, 3);
      expect(await auth.issueSignIn(signIn('d@shopper.test', now + 120_000, 'c'), limits)).toBe(
        false,
      );
      expect(await auth.issueSignIn(signIn('d@shopper.test', now + 900_000, 'c'), limits)).toBe(
        false,
      );
      expect(await auth.issueSignIn(signIn('d@shopper.test', now + 900_001, 'c'), limits)).toBe(
        true,
      );
    });

    it('counts failures across codes: asking again keeps them, so an address gets maxAttempts per window, not per code', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('k@shopper.test', now, 'a'), limits);
      // Two wrong tries, then a new code a minute on...
      for (let i = 0; i < 2; i++)
        expect(await auth.spendAttempt('k@shopper.test', now + 1, 3)).toBe(h('a'));
      expect(await auth.issueSignIn(signIn('k@shopper.test', now + 60_000, 'c'), limits)).toBe(
        true,
      );
      // ...leaves one try, not three: the third failure spends the address's tries.
      expect(await auth.spendAttempt('k@shopper.test', now + 60_001, 3)).toBe(h('c'));
      expect(await auth.spendAttempt('k@shopper.test', now + 60_002, 3)).toBeNull();
      // And a new code is refused until fifteen minutes after the last try.
      expect(await auth.issueSignIn(signIn('k@shopper.test', now + 120_000, 'e'), limits)).toBe(
        false,
      );
      expect(
        await auth.issueSignIn(signIn('k@shopper.test', now + 60_001 + 899_999, 'e'), limits),
      ).toBe(false);
      expect(
        await auth.issueSignIn(signIn('k@shopper.test', now + 60_001 + 900_000, 'e'), limits),
      ).toBe(true);
      // The window had passed, so the tries start again.
      expect(await auth.spendAttempt('k@shopper.test', now + 60_001 + 900_001, 3)).toBe(h('e'));
    });

    it('stops counting failures when the last try is older than the window, or the sign-in was used', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('m@shopper.test', now, 'a'), limits);
      for (let i = 0; i < 2; i++) await auth.spendAttempt('m@shopper.test', now + 1, 3);
      // A new code after the window: all three tries are back.
      const later = now + 1 + 900_000;
      expect(await auth.issueSignIn(signIn('m@shopper.test', later, 'c'), limits)).toBe(true);
      for (let i = 0; i < 3; i++)
        expect(await auth.spendAttempt('m@shopper.test', later + 1, 3)).toBe(h('c'));
      expect(await auth.spendAttempt('m@shopper.test', later + 1, 3)).toBeNull();

      await auth.issueSignIn(signIn('m2@shopper.test', now, 'b'), limits);
      await auth.spendAttempt('m2@shopper.test', now + 1, 3);
      await auth.spendAttempt('m2@shopper.test', now + 1, 3);
      expect(await auth.consumeCode('m2@shopper.test', h('b'), now + 2)).toBe(true);
      // Signed in: the next code starts with all its tries.
      expect(await auth.issueSignIn(signIn('m2@shopper.test', now + 60_000, 'd'), limits)).toBe(
        true,
      );
      for (let i = 0; i < 3; i++)
        expect(await auth.spendAttempt('m2@shopper.test', now + 60_001, 3)).toBe(h('d'));
    });

    it('stops sending to an address after dailyMax in a day, and starts the day again after it', async () => {
      const auth = await make();
      for (let i = 0; i < 4; i++)
        expect(
          await auth.issueSignIn(signIn('n@shopper.test', now + i * 60_000, 'a'), limits),
        ).toBe(true);
      expect(await auth.issueSignIn(signIn('n@shopper.test', now + 5 * 60_000, 'a'), limits)).toBe(
        false,
      );
      expect(
        await auth.issueSignIn(signIn('n@shopper.test', now + 86_400_000 - 1, 'a'), limits),
      ).toBe(false);
      expect(await auth.issueSignIn(signIn('n@shopper.test', now + 86_400_000, 'a'), limits)).toBe(
        true,
      );
      // A different address has its own day.
      expect(await auth.issueSignIn(signIn('n2@shopper.test', now + 5 * 60_000, 'b'), limits)).toBe(
        true,
      );
    });

    it('lets the emailed link in after the code is locked out, and shows who it is for without using it', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('l@shopper.test'), limits);
      for (let i = 0; i < 3; i++) await auth.spendAttempt('l@shopper.test', now + 1, 3);
      expect(await auth.spendAttempt('l@shopper.test', now + 2, 3)).toBeNull();
      expect(await auth.linkEmail(link('a'), now + 3)).toBe('l@shopper.test');
      expect(await auth.linkEmail(link('a'), now + 4)).toBe('l@shopper.test');
      expect(await auth.linkEmail(link('9'), now + 4)).toBeNull();
      expect(await auth.linkEmail(link('a'), now + 600_000)).toBeNull();
      // The lock gates the code and asking again, never the link.
      expect(await auth.consumeLink(link('a'), now + 5)).toBe('l@shopper.test');
      expect(await auth.linkEmail(link('a'), now + 6)).toBeNull();
    });

    it('lets a code be used once, while live, by its own hash', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('e@shopper.test'), limits);
      expect(await auth.consumeCode('e@shopper.test', h('f'), now + 1)).toBe(false);
      expect(await auth.consumeCode('e@shopper.test', h('a'), now + 600_000)).toBe(false);
      expect(await auth.consumeCode('e@shopper.test', h('a'), now + 1)).toBe(true);
      expect(await auth.consumeCode('e@shopper.test', h('a'), now + 2)).toBe(false);
      // Used, so it is no longer there to try.
      expect(await auth.spendAttempt('e@shopper.test', now + 3, 3)).toBeNull();
    });

    it('lets a link be used once, while live, and kills the code with it', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('f@shopper.test'), limits);
      expect(await auth.consumeLink(link('9'), now + 1)).toBeNull();
      expect(await auth.consumeLink(link('a'), now + 600_000)).toBeNull();
      expect(await auth.consumeLink(link('a'), now + 1)).toBe('f@shopper.test');
      expect(await auth.consumeLink(link('a'), now + 2)).toBeNull();
      expect(await auth.consumeCode('f@shopper.test', h('a'), now + 3)).toBe(false);
    });

    it('lets one of two racing redemptions win', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('g@shopper.test'), limits);
      const links = await Promise.all([
        auth.consumeLink(link('a'), now + 1),
        auth.consumeLink(link('a'), now + 1),
      ]);
      expect(links.filter((x) => x !== null)).toEqual(['g@shopper.test']);

      await auth.issueSignIn(signIn('g2@shopper.test', now, 'c'), limits);
      const codes = await Promise.all([
        auth.consumeCode('g2@shopper.test', h('c'), now + 1),
        auth.consumeCode('g2@shopper.test', h('c'), now + 1),
        auth.consumeCode('g2@shopper.test', h('c'), now + 1),
      ]);
      expect(codes.filter(Boolean)).toHaveLength(1);
    });

    it('lets one of two racing sign-ins past the cooldown win', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('r@shopper.test', now, 'a'), limits);
      const asked = await Promise.all([
        auth.issueSignIn(signIn('r@shopper.test', now + 60_000, 'c'), limits),
        auth.issueSignIn(signIn('r@shopper.test', now + 60_000, 'e'), limits),
      ]);
      // Both are past the cooldown of the first; whichever lands second finds the first's new row
      // made at the same instant, inside its own cooldown.
      expect(asked.filter(Boolean)).toHaveLength(1);
    });

    it('reads a session while it is live, and writes nothing to do it', async () => {
      const auth = await make();
      await auth.createSession({
        tokenHash: h('5'),
        email: 's@shopper.test',
        createdAt: now,
        expiresAt: now + 100,
      });
      expect(await auth.session(h('5'), now + 99)).toEqual({
        email: 's@shopper.test',
        createdAt: now,
        expiresAt: now + 100,
        lastSeenAt: null,
      });
      expect(await auth.session(h('5'), now + 100)).toBeNull();
      expect(await auth.session(h('6'), now)).toBeNull();
    });

    it('records a use only when the last was before the line', async () => {
      const auth = await make();
      await auth.createSession({
        tokenHash: h('7'),
        email: 't@shopper.test',
        createdAt: now,
        expiresAt: now + 1e6,
      });
      await auth.touchSession(h('7'), now + 10, now + 10);
      expect((await auth.session(h('7'), now + 11))?.lastSeenAt).toBe(now + 10);
      await auth.touchSession(h('7'), now + 20, now + 10);
      expect((await auth.session(h('7'), now + 21))?.lastSeenAt).toBe(now + 10);
      await auth.touchSession(h('7'), now + 30, now + 11);
      expect((await auth.session(h('7'), now + 31))?.lastSeenAt).toBe(now + 30);
    });

    it('ends one session and no other', async () => {
      const auth = await make();
      for (const t of ['8', '9'])
        await auth.createSession({
          tokenHash: h(t),
          email: 'u@shopper.test',
          createdAt: now,
          expiresAt: now + 1e6,
        });
      expect(await auth.endSession(h('8'))).toBe(true);
      expect(await auth.endSession(h('8'))).toBe(false);
      expect(await auth.session(h('8'), now + 1)).toBeNull();
      expect(await auth.session(h('9'), now + 1)).not.toBeNull();
    });

    it('exports an address’s rows without a hash or a secret', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('v@shopper.test'), limits);
      await auth.createSession({
        tokenHash: h('a'),
        email: 'v@shopper.test',
        createdAt: now,
        expiresAt: now + 5,
      });
      await auth.createSession({
        tokenHash: h('b'),
        email: 'w@shopper.test',
        createdAt: now,
        expiresAt: now + 5,
      });
      const out = await auth.exportFor('v@shopper.test');
      expect(out.signIns).toEqual([
        {
          email: 'v@shopper.test',
          createdAt: now,
          expiresAt: now + 600_000,
          attempts: 0,
          usedAt: null,
        },
      ]);
      expect(out.sessions).toEqual([
        { email: 'v@shopper.test', createdAt: now, expiresAt: now + 5, lastSeenAt: null },
      ]);
      const json = JSON.stringify(out);
      for (const stored of [h('a'), link('a'), h('b')]) expect(json).not.toContain(stored);
    });

    it('erases an address’s sign-ins and sessions, and only theirs', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('x@shopper.test'), limits);
      await auth.issueSignIn(signIn('y@shopper.test', now, 'b'), limits);
      await auth.createSession({
        tokenHash: h('c'),
        email: 'x@shopper.test',
        createdAt: now,
        expiresAt: now + 1e6,
      });
      await auth.createSession({
        tokenHash: h('d'),
        email: 'x@shopper.test',
        createdAt: now,
        expiresAt: now + 1e6,
      });
      await auth.createSession({
        tokenHash: h('e'),
        email: 'y@shopper.test',
        createdAt: now,
        expiresAt: now + 1e6,
      });
      expect(await auth.eraseFor('x@shopper.test')).toEqual({ signIns: 1, sessions: 2 });
      expect(await auth.session(h('c'), now + 1)).toBeNull();
      expect(await auth.session(h('e'), now + 1)).not.toBeNull();
      expect(await auth.spendAttempt('y@shopper.test', now + 1, 3)).toBe(h('b'));
      expect(await auth.eraseFor('x@shopper.test')).toEqual({ signIns: 0, sessions: 0 });
    });

    it('prunes what expired before the lines it is given', async () => {
      const auth = await make();
      await auth.issueSignIn(signIn('p1@shopper.test', now, 'a'), limits);
      await auth.issueSignIn(signIn('p2@shopper.test', now + 1000, 'b'), limits);
      await auth.createSession({
        tokenHash: h('f'),
        email: 'p1@shopper.test',
        createdAt: now,
        expiresAt: now + 10,
      });
      await auth.createSession({
        tokenHash: h('0'),
        email: 'p1@shopper.test',
        createdAt: now,
        expiresAt: now + 1e6,
      });
      // p1's sign-in expired at now+600000, p2's at now+601000.
      expect(await auth.prune({ signIns: now + 600_500, sessions: now + 11 })).toEqual({
        signIns: 1,
        sessions: 1,
      });
      expect(await auth.spendAttempt('p2@shopper.test', now + 1, 3)).not.toBeNull();
      expect(await auth.session(h('0'), now + 12)).not.toBeNull();
    });
  });
}
