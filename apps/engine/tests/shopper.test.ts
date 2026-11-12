/**
 * A storefront shopper's sign-in through `StorefrontApi`: the engine believes the storefront only
 * with an actor signed for `shopper` under the storefront key, mints the session secret and keeps
 * only its hash, and a hash, or a secret without the actor, is no shopper. Also what a data
 * subject request and the retention sweep do with the rows.
 */
import { env } from 'cloudflare:workers';
import {
  type GuestActor,
  hashShopperSecret,
  SHOPPER_CALL,
  SHOPPER_DAY_MS,
  SHOPPER_GUEST_ID,
  SHOPPER_SESSION_TTL_MS,
  signGuestActor,
} from '@commerceworker/core';
import { createDb, shopperSessions, shopperSignIns } from '@commerceworker/db';
import { eq, like } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { sweep } from '../src/retention';
import { StorefrontApi } from '../src/storefront-api';
import { eraseDataSubject, exportDataSubject } from '../src/subjects';
import { signedGuest } from './principal';

const db = () => createDb(env.DB);
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const shopperActor: GuestActor = { kind: 'guest', id: SHOPPER_GUEST_ID, name: 'Shopper' };
const actor = () => signedGuest(shopperActor, SHOPPER_CALL);

/** A send_email binding that keeps what it was given, and an engine env that has it. */
function mailEnv() {
  const sent: { to: string | string[]; subject: string; text?: string; html?: string }[] = [];
  const e = {
    ...env,
    EMAIL: {
      send: async (m: (typeof sent)[number]) => {
        sent.push(m);
        return { messageId: `m${sent.length}` };
      },
    },
    EMAIL_FROM: 'shop@mail.shop.test',
  } as unknown as Env;
  return { sent, env: e, api: new StorefrontApi(ctx, e) };
}

const mailed = (m: { text?: string }) => ({
  code: /code is (\d{6})/.exec(m.text!)![1]!,
  token: /\/account\/confirm\/([0-9a-f]{64})/.exec(m.text!)![1]!,
});

const email = () => `${crypto.randomUUID().slice(0, 8)}@shopper-engine.test`;

beforeEach(async () => {
  await db().delete(shopperSignIns).where(like(shopperSignIns.email, '%@shopper-engine.test'));
  await db().delete(shopperSessions).where(like(shopperSessions.email, '%@shopper-engine.test'));
});

describe('signing in through StorefrontApi', () => {
  it('mails a code and link, redeems either once, and keeps only the session secret’s hash', async () => {
    const { api, sent } = mailEnv();
    const who = email();
    expect(await api.startShopperSignIn(who, await actor())).toEqual({ status: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('Confirm sign-in');
    const { code, token } = mailed(sent[0]!);

    const out = await api.redeemShopperCode(who, code, await actor());
    expect(out).toMatchObject({ email: who });
    expect(out!.secret).toMatch(/^[0-9a-f]{64}$/);
    // Used: neither the code nor the link opens another.
    expect(await api.redeemShopperCode(who, code, await actor())).toBeNull();
    expect(await api.redeemShopperLink(token, await actor())).toBeNull();

    const rows = await db().select().from(shopperSessions).where(eq(shopperSessions.email, who));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(await hashShopperSecret(out!.secret));
    expect(rows[0]!.tokenHash).not.toBe(out!.secret);
    expect(rows[0]!.expiresAt - rows[0]!.createdAt).toBe(SHOPPER_SESSION_TTL_MS);
    // The code is not stored in the clear, nor the link's token.
    const pending = await db().select().from(shopperSignIns).where(eq(shopperSignIns.email, who));
    expect(JSON.stringify(pending)).not.toContain(code);
    expect(JSON.stringify(pending)).not.toContain(token);
  });

  it('redeems the link once when it is the link that is used', async () => {
    const { api, sent } = mailEnv();
    const who = email();
    await api.startShopperSignIn(who, await actor());
    const { code, token } = mailed(sent[0]!);
    const out = await api.redeemShopperLink(token, await actor());
    expect(out?.email).toBe(who);
    expect(await api.redeemShopperLink(token, await actor())).toBeNull();
    expect(await api.redeemShopperCode(who, code, await actor())).toBeNull();
  });

  it('answers the same for any address and sends at most one a minute', async () => {
    const { api, sent } = mailEnv();
    const [a, b] = [email(), email()];
    expect(await api.startShopperSignIn(a, await actor())).toEqual(
      await api.startShopperSignIn(b, await actor()),
    );
    expect(await api.startShopperSignIn(a, await actor())).toEqual({ status: 'wait' });
    expect(sent).toHaveLength(2);
    expect(await api.startShopperSignIn('not an address', await actor())).toEqual({
      status: 'invalid',
    });
  });

  it('is unavailable where there is no Email Sending, and writes nothing', async () => {
    const api = new StorefrontApi(ctx, env);
    const who = email();
    expect(await api.startShopperSignIn(who, await actor())).toEqual({ status: 'unavailable' });
    expect(await db().select().from(shopperSignIns).where(eq(shopperSignIns.email, who))).toEqual(
      [],
    );
  });
});

describe('who the engine believes', () => {
  async function signedIn() {
    const { api, sent } = mailEnv();
    const who = email();
    await api.startShopperSignIn(who, await actor());
    const out = (await api.redeemShopperCode(who, mailed(sent[0]!).code, await actor()))!;
    return { api, who, out, sent };
  }

  it('names the shopper for the cookie’s secret with the storefront’s actor', async () => {
    const { api, who, out } = await signedIn();
    expect(await api.shopper(out.secret, await actor())).toMatchObject({
      email: who,
      expiresAt: out.expiresAt,
    });
  });

  it('refuses the stored hash presented as a secret', async () => {
    const { api, out } = await signedIn();
    const hash = await hashShopperSecret(out.secret);
    expect(await api.shopper(hash, await actor())).toBeNull();
    await api.shopperSignOut(hash, await actor());
    // Signing out with a hash ended nothing.
    expect(await api.shopper(out.secret, await actor())).not.toBeNull();
  });

  it('refuses the secret without an actor, and with one signed for anything else', async () => {
    const { api, out } = await signedIn();
    expect(await api.shopper(out.secret, 'forged')).toBeNull();
    const other = await signedGuest(shopperActor, 'checkout:chk_1');
    expect(await api.shopper(out.secret, other)).toBeNull();
    // The right call, but a different guest.
    const stranger = await signedGuest({ ...shopperActor, id: 'guest:someone' }, SHOPPER_CALL);
    expect(await api.shopper(out.secret, stranger)).toBeNull();
    // Signed under a key that isn't the storefront's (the principal key itself).
    const wrongKey = await signGuestActor(
      (env as { PRINCIPAL_KEY?: string }).PRINCIPAL_KEY!,
      shopperActor,
      SHOPPER_CALL,
    );
    expect(await api.shopper(out.secret, wrongKey)).toBeNull();
    // Nor does a secret that isn't one of the engine's shape do anything.
    expect(await api.shopper('x', await actor())).toBeNull();
    expect(await api.shopper(out.secret.toUpperCase(), await actor())).toBeNull();
    expect(await api.shopper(out.secret, await actor())).not.toBeNull();
  });

  it('refuses every sign-in call that lacks the actor', async () => {
    const { api, sent } = mailEnv();
    const who = email();
    expect(await api.startShopperSignIn(who, 'forged')).toEqual({ status: 'invalid' });
    expect(sent).toHaveLength(0);
    await api.startShopperSignIn(who, await actor());
    const { code, token } = mailed(sent[0]!);
    expect(await api.redeemShopperCode(who, code, 'forged')).toBeNull();
    expect(await api.redeemShopperLink(token, 'forged')).toBeNull();
    // The refusals didn't spend the sign-in.
    expect(await api.redeemShopperCode(who, code, await actor())).not.toBeNull();
  });

  it('previews an unspent link, masked, without using it, and only for the storefront', async () => {
    const { api, sent } = mailEnv();
    const who = email();
    await api.startShopperSignIn(who, await actor());
    const { token } = mailed(sent[0]!);
    expect(await api.shopperLinkPreview(token, await actor())).toEqual({
      masked: `${who[0]}***${who.slice(who.indexOf('@'))}`,
    });
    expect(await api.shopperLinkPreview(token, 'forged')).toBeNull();
    expect(
      await api.shopperLinkPreview(token, await signedGuest(shopperActor, 'checkout:chk_1')),
    ).toBeNull();
    // Nothing was used: it still redeems, once, and then previews nothing.
    expect(await api.redeemShopperLink(token, await actor())).not.toBeNull();
    expect(await api.shopperLinkPreview(token, await actor())).toBeNull();
  });

  it('ends the session at sign-out, for that session alone', async () => {
    const { api, who, out } = await signedIn();
    await db()
      .insert(shopperSessions)
      .values({
        tokenHash: await hashShopperSecret('other-session'),
        email: who,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
    await api.shopperSignOut(out.secret, await actor());
    expect(await api.shopper(out.secret, await actor())).toBeNull();
    const left = await db().select().from(shopperSessions).where(eq(shopperSessions.email, who));
    expect(left).toHaveLength(1);
  });
});

describe('personal data and retention', () => {
  it('exports an address’s sign-ins and sessions and erases them, ending every session', async () => {
    const { api, sent } = mailEnv();
    const [who, other] = [email(), email()];
    await api.startShopperSignIn(who, await actor());
    await api.startShopperSignIn(other, await actor());
    const mine = (await api.redeemShopperCode(who, mailed(sent[0]!).code, await actor()))!;
    const theirs = (await api.redeemShopperCode(other, mailed(sent[1]!).code, await actor()))!;

    const exported = await exportDataSubject(env, ` ${who.toUpperCase()} `);
    expect(exported.shopperSessions).toHaveLength(1);
    expect(exported.shopperSignIns).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toContain(mine.secret);
    expect(JSON.stringify(exported)).not.toContain(await hashShopperSecret(mine.secret));

    expect(await eraseDataSubject(env, who)).toMatchObject({
      ok: true,
      shopperSignIns: 1,
      shopperSessions: 1,
    });
    expect(await api.shopper(mine.secret, await actor())).toBeNull();
    expect(await api.shopper(theirs.secret, await actor())).not.toBeNull();
    expect((await exportDataSubject(env, who)).shopperSessions).toEqual([]);
  });

  it('sweeps expired sessions, and sign-ins a day after they expire', async () => {
    const now = Date.now();
    const [live, gone, fresh] = [email(), email(), email()];
    const row = (e: string, createdAt: number, expiresAt: number) => ({
      email: e,
      codeHash: 'c'.repeat(64),
      linkHash: `${e}-link`.padEnd(64, '0').slice(0, 64),
      expiresAt,
      createdAt,
      dayStartedAt: createdAt,
    });
    await db()
      .insert(shopperSignIns)
      .values([
        // Expired over a day ago: gone. Expired a minute ago: kept, since its row holds the cooldown,
        // the carried tries and the day's count.
        row(gone, now - 2 * SHOPPER_DAY_MS, now - SHOPPER_DAY_MS - 1),
        row(fresh, now - 11 * 60_000, now - 60_000),
        row(live, now, now + 600_000),
      ]);
    await db()
      .insert(shopperSessions)
      .values([
        { tokenHash: `${gone}-s`, email: gone, createdAt: 0, expiresAt: now - 1 },
        { tokenHash: `${live}-s`, email: live, createdAt: 0, expiresAt: now + 60_000 },
      ]);
    const swept = await sweep(env, now);
    expect(swept.shopperAuth).toEqual({ signIns: 1, sessions: 1 });
    const left = async (e: string) => [
      (await db().select().from(shopperSignIns).where(eq(shopperSignIns.email, e))).length,
      (await db().select().from(shopperSessions).where(eq(shopperSessions.email, e))).length,
    ];
    expect(await left(gone)).toEqual([0, 0]);
    expect(await left(fresh)).toEqual([1, 0]);
    expect(await left(live)).toEqual([1, 1]);
  });
});
