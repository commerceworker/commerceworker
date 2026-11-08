import { SecretUnreadableError } from '@commerceworker/domain';
import type { SecretSealer } from '@commerceworker/ports';

/**
 * Secrets at rest: AES-256-GCM under a key derived (HKDF-SHA-256) from the
 * deployment's `DATA_KEY`. A sealed value reads `e1.<kid>.<iv>.<ciphertext>`
 * (base64url parts); `kid` says which key sealed it, so during a rotation the
 * values under the previous key (`DATA_KEY_PREVIOUS`) still open while the
 * daily sweep (`resealSecrets`) moves them onto the new one.
 *
 * Every value is bound to where it lives (`context`, see `secretContext`) as
 * GCM associated data: a ciphertext copied into another row or column fails
 * authentication instead of decrypting.
 *
 * Every stored secret is sealed: a value without the `e1.` prefix does not
 * open (it is either corrupt or was written around the sealer).
 *
 * WebCrypto only (no `node:crypto`), so the same code runs in workerd and Node.
 * This is the implementation of the `SecretSealer` port; it lives here, beside
 * `createHasher` (the `Hasher` port's implementation), because it is pure
 * computation with no I/O — not an adapter to an external system.
 */

const VERSION = 'e1';
const HKDF_INFO = 'commerceworker data v1';
const KID_LABEL = 'commerceworker data key id';
/** 96-bit GCM nonce; a fresh random one per seal. */
const IV_BYTES = 12;

/** Minimum DATA_KEY length a secure deployment accepts (it is HKDF input keying material). */
export const MIN_DATA_KEY_LENGTH = 32;

/**
 * The key local persistent dev (`wrangler dev` against local D1 with
 * REQUIRE_SECURE_SECRETS=false) seals with when DATA_KEY is unset. Fixed so
 * sealed values survive a restart; refused wherever secure secrets are required.
 */
export const DEV_DATA_KEY = 'commerceworker-local-dev-data-key-not-for-production';

/** Where each stored secret lives, as its sealing context (the GCM associated data). */
export const secretContext = {
  webhookSecret: (webhookId: string) => `webhooks.secret:${webhookId}`,
  webhookHeader: (webhookId: string, name: string) => `webhooks.headers:${webhookId}:${name}`,
  /** One secret plugin setting; bound to the space and plugin, so it never opens in another. */
  pluginSetting: (spaceId: string, pluginId: string, key: string) =>
    `plugin_settings.secrets:${spaceId}/${pluginId}:${key}`,
} as const;

const enc = new TextEncoder();
const dec = new TextDecoder();

type AesKey = Awaited<ReturnType<typeof crypto.subtle.deriveKey>>;
interface Derived {
  readonly kid: string;
  readonly key: AesKey;
}

// Isolate-lifetime memo: derivation is two WebCrypto imports + an HMAC, and the
// same one or two keys serve every request.
const derived = new Map<string, Promise<Derived>>();

function derive(secret: string): Promise<Derived> {
  let d = derived.get(secret);
  if (!d) {
    d = (async () => {
      const raw = enc.encode(secret);
      const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: enc.encode(HKDF_INFO) },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      // The key id is an HMAC of a fixed label under the secret: stable for a
      // key, reveals nothing about it, and is independent of the AES key
      // (separate label, separate primitive).
      const mac = await crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const tag = new Uint8Array(await crypto.subtle.sign('HMAC', mac, enc.encode(KID_LABEL)));
      return { kid: b64url(tag.slice(0, 6)), key };
    })();
    // A failed derivation must not poison the memo.
    d.catch(() => derived.delete(secret));
    derived.set(secret, d);
  }
  return d;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Whether a stored value is in the sealed format. */
export const isSealedSecret = (stored: string): boolean => stored.startsWith(`${VERSION}.`);

export interface SecretSealerKeys {
  /** `DATA_KEY`: seals every new value. */
  readonly current: string;
  /** `DATA_KEY_PREVIOUS`: only opens values sealed before a rotation. */
  readonly previous?: string;
}

/**
 * Builds the `SecretSealer` for a deployment's keys. Throws on an empty
 * current key — callers decide (fail closed, or a dev key) before this point.
 */
export function createSecretSealer(keys: SecretSealerKeys): SecretSealer {
  if (!keys.current) throw new Error('DATA_KEY is not set: secrets cannot be sealed');
  const openKeys = [keys.current, ...(keys.previous ? [keys.previous] : [])];

  return {
    async seal(plaintext, context) {
      const { kid, key } = await derive(keys.current);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: enc.encode(context) },
        key,
        enc.encode(plaintext),
      );
      return `${VERSION}.${kid}.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
    },

    async open(stored, context) {
      if (!isSealedSecret(stored)) throw new SecretUnreadableError(context);
      const [, kid, iv, ct, extra] = stored.split('.');
      if (!kid || !iv || !ct || extra !== undefined) throw new SecretUnreadableError(context);
      for (const secret of openKeys) {
        const d = await derive(secret);
        if (d.kid !== kid) continue;
        try {
          const pt = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: fromB64url(iv), additionalData: enc.encode(context) },
            d.key,
            fromB64url(ct),
          );
          return dec.decode(pt);
        } catch {
          // Right key id, failed authentication: wrong context, or tampered.
          break;
        }
      }
      throw new SecretUnreadableError(context);
    },

    async currentPrefix() {
      return `${VERSION}.${(await derive(keys.current)).kid}.`;
    },
  };
}
