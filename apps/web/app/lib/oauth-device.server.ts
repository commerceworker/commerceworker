/**
 * The OAuth device authorization grant (RFC 8628) beside the authorization server
 * (lib/oauth.server.ts): the state of one sign-in from a terminal, in `OAUTH_KV`.
 *
 * The library has no device grant, so a sign-in is an authorization-code grant it mints once a
 * person approves, with a PKCE verifier that is the device code itself: `device_code` is 32 random
 * bytes the terminal holds, and what is stored is its S256 challenge. The record is keyed by that
 * challenge, so reading `OAUTH_KV` yields neither the device code nor anything that redeems the
 * authorization code the record holds once approved (the library checks the verifier against the
 * challenge). The user code is looked up by its hash, never stored. Everything is TTL'd.
 */

import { env } from 'cloudflare:workers';
import type { Role } from '@commerceworker/core';
import { base64url, randomToken, sha256Hex } from './credentials';

/** The grant type the terminal polls with (RFC 8628 §3.4). */
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/**
 * The return address a device client is registered with. It is on a reserved TLD (RFC 6761), so a
 * browser flow can never deliver a code to anyone, and nothing of ours serves it: the code a device
 * approval mints is held here and redeemed with the device code. The consent page refuses it.
 */
export const DEVICE_REDIRECT = 'https://device.invalid/';
/** The first-party CLI's fixed client id: seeded (`ensureCliClient`), device-only, never a browser app. */
export const CLI_CLIENT_ID = 'commerceworker-cli';
export const CLI_CLIENT_NAME = 'CommerceWorker CLI';
export const DEVICE_AUTHORIZATION_PATH = '/oauth/device_authorization';
/** Where a person enters the code: a page of the app (routes/oauth-device.tsx). */
export const DEVICE_VERIFICATION_PATH = '/oauth/device';

/** How long a code lives (RFC 8628 §3.2 recommends short). Approval doesn't extend it. */
export const DEVICE_TTL_S = 600;
export const DEVICE_INTERVAL_S = 5;
/** Wrong approvals (step-up failures) a code survives, and wrong code entries a person survives. */
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_ENTRY_MISSES = 10;

/**
 * No vowels (a code can't spell a word), no 0/O or 1/I/L: what a person reads off a screen and
 * types without a second look. 27 symbols, 8 places: about 2.8e11 codes.
 */
const ALPHABET = 'BCDFGHJKMNPQRSTVWXZ23456789';

/**
 * A person's decision, in a key of its own (`cmw_device_decision:<id>`). The record below is
 * written by polls (`lastPoll`, `interval`) from a copy they read earlier, so a decision kept in it
 * could be overwritten back to pending by a poll that read it before the decision landed. Polls
 * only read the decision; only an approval or a denial writes it.
 */
export type Decision =
  | { status: 'approved'; code: string; redirectUri: string }
  | { status: 'denied' };

export type DeviceRecord = {
  clientId: string;
  /** The role the terminal asked for: the most an approver may give it. */
  role: Exclude<Role, 'admin'>;
  resource: string;
  /** Hash of the user code, to take the lookup entry down with the record. */
  userKey: string;
  /** Where and when the terminal asked, shown to the approver (RFC 8628 §5.4). */
  origin: { ip: string; place: string | null; at: number };
  expiresAt: number;
  interval: number;
  lastPoll: number;
};

const clientKey = (clientId: string) => `cmw_device_client:${clientId}`;
const redeemKey = (id: string) => `cmw_device_redeem:${id}`;
const decisionKey = (id: string) => `cmw_device_decision:${id}`;
const attemptsKey = (id: string) => `cmw_device_attempts:${id}`;
const recordKey = (id: string) => `cmw_device:${id}`;
const userKeyOf = async (userCode: string) =>
  `cmw_device_user:${await sha256Hex(`device-user:${userCode}`)}`;
const missKey = (userId: string) => `cmw_device_miss:${userId}`;

/** What the terminal sees and the person types: XXXX-XXXX. */
export const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** What a person typed, whatever the case, spaces or dash; null unless it can be a code. */
export function normalizeUserCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return code.length === 8 && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

function newUserCode(): string {
  let out = '';
  // Rejection sampling, so every symbol is equally likely.
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < 8)
    for (const b of crypto.getRandomValues(new Uint8Array(16)))
      if (b < limit && out.length < 8) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** The PKCE challenge of a device code: also the record's id. */
export async function deviceId(deviceCode: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceCode));
  return base64url(new Uint8Array(digest));
}

const load = (id: string) => env.OAUTH_KV.get<DeviceRecord>(recordKey(id), 'json');
const save = (id: string, r: DeviceRecord) =>
  env.OAUTH_KV.put(recordKey(id), JSON.stringify(r), {
    // KV's floor is 60 seconds; expiresAt is what's checked.
    expirationTtl: Math.max(60, Math.ceil((r.expiresAt - Date.now()) / 1000)),
  });

/** A client that registered for the device grant: only these may start a device sign-in. */
export const markDeviceClient = (clientId: string) => env.OAUTH_KV.put(clientKey(clientId), '1');
export async function isDeviceClient(clientId: string) {
  return clientId === CLI_CLIENT_ID || (await env.OAUTH_KV.get(clientKey(clientId))) !== null;
}

/**
 * The first-party CLI as a registered client, written in the shape the provider's `createClient`
 * stores (`client:<id>`; the one place this code leans on the library's internals, so the
 * version is pinned). Public, authorization-code with refresh, and no return address but
 * `DEVICE_REDIRECT`. Written only when absent, so it is safe on every start.
 */
export async function ensureCliClient() {
  const key = `client:${CLI_CLIENT_ID}`;
  if ((await env.OAUTH_KV.get(key)) !== null) return;
  await env.OAUTH_KV.put(
    key,
    JSON.stringify({
      clientId: CLI_CLIENT_ID,
      redirectUris: [DEVICE_REDIRECT],
      clientName: CLI_CLIENT_NAME,
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      registrationDate: Math.floor(Date.now() / 1000),
      tokenEndpointAuthMethod: 'none',
      authMethodExplicit: true,
    }),
  );
}

/**
 * Whether a registering client's name passes itself off as the first-party CLI: whatever the
 * case, spacing, punctuation, accents or look-alike digits, "commerceworker" with "cli",
 * "official" or "terminal".
 */
export function imitatesCli(name: string): boolean {
  const n = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/3/g, 'e')
    // l, i and the digits and bars that pass for them are one letter.
    .replace(/[1!|l]/g, 'i')
    .replace(/[^a-z]/g, '');
  return n.includes('commerceworker') && /(cii|officiai|terminai)/.test(n);
}

export async function startDevice(input: {
  clientId: string;
  role: DeviceRecord['role'];
  resource: string;
  origin: DeviceRecord['origin'];
}) {
  const deviceCode = randomToken(32);
  const id = await deviceId(deviceCode);
  // A collision of 2.8e11 is vanishingly rare, but never overwrite a live code's lookup.
  let userCode = newUserCode();
  for (let i = 0; i < 5 && (await env.OAUTH_KV.get(await userKeyOf(userCode))); i++)
    userCode = newUserCode();
  const userKey = await userKeyOf(userCode);
  const now = Date.now();
  const record: DeviceRecord = {
    ...input,
    userKey,
    expiresAt: now + DEVICE_TTL_S * 1000,
    interval: DEVICE_INTERVAL_S,
    lastPoll: 0,
  };
  await save(id, record);
  await env.OAUTH_KV.put(userKey, id, { expirationTtl: DEVICE_TTL_S });
  return { deviceCode, userCode, record };
}

export type Lookup =
  | { found: { id: string; record: DeviceRecord } }
  | { refused: 'locked' | 'unknown' };

/** A code nobody has decided on, is not burned and has not expired. */
async function undecided(id: string): Promise<DeviceRecord | null> {
  const record = await load(id);
  if (!record || record.expiresAt <= Date.now()) return null;
  if ((await env.OAUTH_KV.get(decisionKey(id))) !== null) return null;
  return Number((await env.OAUTH_KV.get(attemptsKey(id))) ?? 0) < MAX_CODE_ATTEMPTS ? record : null;
}

/**
 * An open code by what a person typed. Misses are counted per person, and past
 * `MAX_ENTRY_MISSES` in ten minutes the person is refused outright, so the code space can't be
 * walked from a stolen session; a code burned by wrong approvals reads as unknown.
 */
export async function findByUserCode(userCode: string, userId: string): Promise<Lookup> {
  const misses = Number((await env.OAUTH_KV.get(missKey(userId))) ?? 0);
  if (misses >= MAX_ENTRY_MISSES) return { refused: 'locked' };
  const normalized = normalizeUserCode(userCode);
  const id = normalized ? await env.OAUTH_KV.get(await userKeyOf(normalized)) : null;
  const record = id ? await undecided(id) : null;
  if (id && record) return { found: { id, record } };
  await env.OAUTH_KV.put(missKey(userId), String(misses + 1), { expirationTtl: 600 });
  return { refused: 'unknown' };
}

/** An open code by its id, for the decision that follows a lookup. */
export const pending = undecided;

const decide = (id: string, record: DeviceRecord, decision: Decision) =>
  Promise.all([
    env.OAUTH_KV.put(decisionKey(id), JSON.stringify(decision), {
      expirationTtl: Math.max(60, Math.ceil((record.expiresAt - Date.now()) / 1000)),
    }),
    env.OAUTH_KV.delete(record.userKey),
  ]);

export const approveDevice = (
  id: string,
  record: DeviceRecord,
  grant: { code: string; redirectUri: string },
) => decide(id, record, { status: 'approved', ...grant });

export const denyDevice = (id: string, record: DeviceRecord) =>
  decide(id, record, { status: 'denied' });

/** A wrong step-up on this code: after `MAX_CODE_ATTEMPTS` it is burned, as a denial. */
export async function failApproval(id: string, record: DeviceRecord): Promise<boolean> {
  const attempts = Number((await env.OAUTH_KV.get(attemptsKey(id))) ?? 0) + 1;
  await env.OAUTH_KV.put(attemptsKey(id), String(attempts), { expirationTtl: DEVICE_TTL_S });
  if (attempts < MAX_CODE_ATTEMPTS) return false;
  await denyDevice(id, record);
  return true;
}

export type Poll =
  | { error: string; description: string; interval?: number }
  | { exchange: { code: string; redirectUri: string; resource: string } };

const gone = { error: 'expired_token', description: 'This device code has expired. Start again.' };
const spent = { error: 'invalid_grant', description: 'This device code was already used.' };

/**
 * One poll of `/oauth/token` with the device grant (RFC 8628 §3.5). A code answers only the client
 * it was issued to (anyone else learns nothing about it, and doesn't slow it down). A poll only
 * reads the decision and writes `lastPoll` and `interval` to the record, never a status, so
 * nothing it does can undo an approval or a denial. Approved, the code is handed over once.
 */
export async function pollDevice(deviceCode: string, clientId: string): Promise<Poll> {
  const id = await deviceId(deviceCode);
  const record = await load(id);
  if (!record) return gone;
  if (record.clientId !== clientId)
    return {
      error: 'invalid_grant',
      description: 'This device code was not issued to this client.',
    };
  const now = Date.now();
  if (record.expiresAt <= now) {
    await Promise.all(
      [recordKey(id), decisionKey(id), record.userKey].map((k) => env.OAUTH_KV.delete(k)),
    );
    return gone;
  }
  const decision = await env.OAUTH_KV.get<Decision>(decisionKey(id), 'json');
  if (decision?.status === 'denied') {
    // Said once; after that the code is gone.
    await Promise.all([recordKey(id), decisionKey(id)].map((k) => env.OAUTH_KV.delete(k)));
    return { error: 'access_denied', description: 'The person denied this sign-in.' };
  }
  if (!decision) {
    if ((await env.OAUTH_KV.get(redeemKey(id))) !== null) return spent;
    if (now - record.lastPoll < record.interval * 1000) {
      const interval = record.interval + 5;
      await save(id, { ...record, interval, lastPoll: now });
      return { error: 'slow_down', description: 'Poll less often.', interval };
    }
    await save(id, { ...record, lastPoll: now });
    return { error: 'authorization_pending', description: 'Waiting for the person to approve.' };
  }
  // KV has no compare-and-set, so two polls at once could both read an approved decision. Each
  // writes its own nonce and goes on only if its own is what it reads back; and if both still did,
  // the provider spends an authorization code once and revokes the grant on its replay.
  if ((await env.OAUTH_KV.get(redeemKey(id))) !== null) return spent;
  const nonce = randomToken(8);
  await env.OAUTH_KV.put(redeemKey(id), nonce, { expirationTtl: DEVICE_TTL_S });
  if ((await env.OAUTH_KV.get(redeemKey(id))) !== nonce) return spent;
  // The code leaves the namespace as it is handed over.
  await env.OAUTH_KV.delete(decisionKey(id));
  return {
    exchange: { code: decision.code, redirectUri: decision.redirectUri, resource: record.resource },
  };
}
