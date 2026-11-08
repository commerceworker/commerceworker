/**
 * The assistant's principal key: an HMAC secret derived from `PRINCIPAL_KEY` with HKDF-SHA256, for
 * principals the web gateway signs for the assistant's paths (`/agents/*`). The engine, which
 * hosts the assistant, holds only this derived key (`ASSISTANT_PRINCIPAL_KEY`), so a principal it
 * could forge is good for the assistant's socket and nothing else: the api's REST surface verifies
 * with the main key only.
 *
 * No imports, so `scripts/derive-assistant-key.ts` (node:crypto `hkdfSync`, for CI) reads the same
 * salt and info, and `scripts/derive-assistant-key.test.ts` holds the two to the same answer.
 */

/** Fixed, public: HKDF's salt only separates this use from any other use of the same key. */
export const ASSISTANT_KEY_SALT = 'commerceworker/principal-subkeys';
/** What the derived key is for, and its version: a new purpose or scheme takes a new info. */
export const ASSISTANT_KEY_INFO = 'commerceworker/assistant-principal/v1';
/** 32 bytes, as base64url (43 characters). */
export const ASSISTANT_KEY_BYTES = 32;

/**
 * `deriveAssistantPrincipalKey(DEV_PRINCIPAL_KEY)`: local development's assistant key (vite.config.ts
 * gives it to the engine). Never a deployment's.
 */
export const DEV_ASSISTANT_PRINCIPAL_KEY = 'CvDGiymE3tnmVoieH14S8IpI8fonyHyHuK0KAcJD1oA';

/**
 * Whether a principal for this target is signed with the assistant's key instead of the main one.
 * Takes the signed target (`principalTarget`: `GET /agents/…`) or a bare path.
 */
export const isAssistantPrincipalPath = (target: string) =>
  target.replace(/^[A-Z]+ /, '').startsWith('/agents/');

const enc = new TextEncoder();
const derived = new Map<string, Promise<string>>();

const b64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** The assistant's principal key for `secret` (a `PRINCIPAL_KEY`); derived once per secret. */
export function deriveAssistantPrincipalKey(secret: string): Promise<string> {
  if (!secret) return Promise.reject(new Error('PRINCIPAL_KEY is not set'));
  let key = derived.get(secret);
  if (!key) {
    key = (async () => {
      const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
        'deriveBits',
      ]);
      const bits = await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: enc.encode(ASSISTANT_KEY_SALT),
          info: enc.encode(ASSISTANT_KEY_INFO),
        },
        ikm,
        ASSISTANT_KEY_BYTES * 8,
      );
      return b64url(new Uint8Array(bits));
    })();
    derived.set(secret, key);
    key.catch(() => derived.delete(secret));
  }
  return key;
}
