/**
 * A storefront shopper's sign-in by emailed code or link (the rules, and why a shopper is a
 * verified address and no account, in core's `shopper.ts`).
 *
 * `startShopperSignIn` mails a six-digit code and a link token for any address that is one: it
 * never looks at orders, so its answer can't tell whether the address has any. Both are stored as
 * hashes and live ten minutes; asking again replaces them, at most once a minute, and an address
 * that spent its five tries (counted across its codes, so a new one resets nothing) is sent nothing
 * for fifteen minutes from its last try, and nothing past twenty a day. `redeemShopperCode` counts the try
 * before it compares (in constant time, against a stand-in when there is nothing to compare, so a
 * missing sign-in takes as long as a wrong code) and uses the sign-in in one guarded write, so two
 * racing redemptions, of the code or of the link, can't both mint a session. A redemption mints
 * the session secret here and returns it once; only its SHA-256 is kept, and `shopperSession` and
 * `shopperSignOut` take that hash. Time comes in as `now`.
 */
import {
  constantTimeEqual,
  hashShopperCode,
  hashShopperSecret,
  maskShopperEmail,
  newShopperCode,
  newShopperSecret,
  SHOPPER_CODE,
  SHOPPER_CODE_TTL_MS,
  SHOPPER_COOLDOWN_MS,
  SHOPPER_DAILY_MAX,
  SHOPPER_DAY_MS,
  SHOPPER_LOCKOUT_MS,
  SHOPPER_MAX_ATTEMPTS,
  SHOPPER_SECRET,
  SHOPPER_SESSION_TTL_MS,
  SHOPPER_TOUCH_MS,
  type ShopperSignedIn,
  type ShopperStart,
  type ShopperView,
  shopperEmail,
  shopperLinkUrl,
  shopperSignInEmail,
} from '@commerceworker/core';
import type { EmailSender } from '@commerceworker/ports';
import type { ShopperAuth } from '@commerceworker/ports/commerce';

export type ShopperPorts = {
  readonly shoppers: ShopperAuth;
  /** The key codes are hashed under (`shopperCodeKey`). */
  readonly codeKey: string;
};

export type ShopperStartPorts = ShopperPorts & {
  /** Undefined on a deployment with no Email Sending binding. */
  readonly email: EmailSender | undefined;
  /** The storefront's origin, where the link goes. */
  readonly storefrontOrigin: string;
};

export async function startShopperSignIn(
  ports: ShopperStartPorts,
  rawEmail: unknown,
  now: number,
): Promise<ShopperStart> {
  const email = shopperEmail(rawEmail);
  if (!email) return { status: 'invalid' };
  if (!ports.email) return { status: 'unavailable' };

  const code = newShopperCode();
  const token = newShopperSecret();
  const issued = await ports.shoppers.issueSignIn(
    {
      email,
      codeHash: await hashShopperCode(ports.codeKey, email, code),
      linkHash: await hashShopperSecret(token),
      createdAt: now,
      expiresAt: now + SHOPPER_CODE_TTL_MS,
    },
    {
      cooldownMs: SHOPPER_COOLDOWN_MS,
      lockoutMs: SHOPPER_LOCKOUT_MS,
      maxAttempts: SHOPPER_MAX_ATTEMPTS,
      dailyMax: SHOPPER_DAILY_MAX,
      dayMs: SHOPPER_DAY_MS,
    },
  );
  if (!issued) return { status: 'wait' };

  const mail = shopperSignInEmail(code, shopperLinkUrl(ports.storefrontOrigin, token));
  try {
    const sent = await ports.email.send({
      to: [email],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    if (sent.delivered) return { status: 'sent' };
    console.warn(JSON.stringify({ type: 'shopper_sign_in_unsent', error: sent.error }));
  } catch (err) {
    console.warn(JSON.stringify({ type: 'shopper_sign_in_unsent', error: String(err) }));
  }
  return { status: 'failed' };
}

/** A session for `email`, its secret returned once. */
async function startSession(
  ports: Pick<ShopperPorts, 'shoppers'>,
  email: string,
  now: number,
): Promise<ShopperSignedIn> {
  const secret = newShopperSecret();
  const expiresAt = now + SHOPPER_SESSION_TTL_MS;
  await ports.shoppers.createSession({
    tokenHash: await hashShopperSecret(secret),
    email,
    createdAt: now,
    expiresAt,
  });
  return { secret, email, expiresAt };
}

/** What a missing sign-in is compared to, so it takes as long as a wrong code. */
const STAND_IN = '0'.repeat(64);

export async function redeemShopperCode(
  ports: ShopperPorts,
  rawEmail: unknown,
  rawCode: unknown,
  now: number,
): Promise<ShopperSignedIn | null> {
  const email = shopperEmail(rawEmail);
  if (!email || typeof rawCode !== 'string' || !SHOPPER_CODE.test(rawCode)) return null;
  const given = await hashShopperCode(ports.codeKey, email, rawCode);
  const stored = await ports.shoppers.spendAttempt(email, now, SHOPPER_MAX_ATTEMPTS);
  const match = constantTimeEqual(given, stored ?? STAND_IN);
  if (!stored || !match) return null;
  // The use is the check: of two redemptions that both matched, one writes.
  if (!(await ports.shoppers.consumeCode(email, given, now))) return null;
  return startSession(ports, email, now);
}

export async function redeemShopperLink(
  ports: Pick<ShopperPorts, 'shoppers'>,
  token: unknown,
  now: number,
): Promise<ShopperSignedIn | null> {
  if (typeof token !== 'string' || !SHOPPER_SECRET.test(token)) return null;
  const email = await ports.shoppers.consumeLink(await hashShopperSecret(token), now);
  return email ? startSession(ports, email, now) : null;
}

/**
 * Who an unspent link would sign in, masked (`p***@example.com`); null for one that is unknown,
 * used or expired. Reads only, so the page that shows it may be opened by anything.
 */
export async function shopperLinkPreview(
  ports: Pick<ShopperPorts, 'shoppers'>,
  token: unknown,
  now: number,
): Promise<{ masked: string } | null> {
  if (typeof token !== 'string' || !SHOPPER_SECRET.test(token)) return null;
  const email = await ports.shoppers.linkEmail(await hashShopperSecret(token), now);
  return email ? { masked: maskShopperEmail(email) } : null;
}

/**
 * Who a session is, by its secret's hash; null once it ended or expired. A read, except that its
 * last use is recorded when the last record is over an hour old.
 */
export async function shopperSession(
  ports: Pick<ShopperPorts, 'shoppers'>,
  tokenHash: string,
  now: number,
): Promise<ShopperView | null> {
  const row = await ports.shoppers.session(tokenHash, now);
  if (!row) return null;
  if (row.lastSeenAt === null || row.lastSeenAt < now - SHOPPER_TOUCH_MS)
    await ports.shoppers.touchSession(tokenHash, now, now - SHOPPER_TOUCH_MS);
  return { email: row.email, since: row.createdAt, expiresAt: row.expiresAt };
}

/** Ends a session by its secret's hash. */
export async function shopperSignOut(
  ports: Pick<ShopperPorts, 'shoppers'>,
  tokenHash: string,
): Promise<void> {
  await ports.shoppers.endSession(tokenHash);
}

/**
 * Deletes sign-ins and sessions that are over. A sign-in is kept a day past its expiry: its row
 * holds the address's carried tries, lockout and daily count, which a delete would forget.
 */
export const pruneShopperAuth = (ports: Pick<ShopperPorts, 'shoppers'>, now: number) =>
  ports.shoppers.prune({
    signIns: now - Math.max(SHOPPER_LOCKOUT_MS, SHOPPER_DAY_MS),
    sessions: now,
  });
