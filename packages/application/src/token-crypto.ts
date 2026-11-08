import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Hasher } from '@commerceworker/ports';

/**
 * A high-entropy random secret for bearer tokens (API keys, preview tokens).
 * Uses a CSPRNG rather than concatenated UUIDv7s, which embed a millisecond
 * timestamp and only ~74 random bits each — a secret should carry no structure.
 */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hex SHA-256 of `value` — content checksums, where hex is the conventional form. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Base64url-encoded SHA-256 of `value` — the PKCE `S256` transformation
 * (RFC 7636 §4.2). Kept here beside the other token primitives so the domain's
 * `verifyPkce` can stay dependency-free and take this as a parameter.
 */
export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

/**
 * A device-flow user code drawn uniformly from `alphabet`.
 *
 * Rejection sampling, not modulo: `randomBytes % 27` would make the first few
 * letters of a 27-character alphabet measurably likelier, shrinking the search
 * space for a code that is already deliberately short.
 */
export function randomUserCode(alphabet: string, length: number): string {
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= max) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Known dev defaults that must not be used when secure secrets are required. */
export const DEV_TOKEN_DEFAULTS = new Set([
  'dev-cma-key',
  'dev-cda-key',
  'dev-cpa-key',
  'dev-admin-token',
  'dev-mcp-token',
  'dev-session-secret-change-me-in-production',
  // packages/security's DEV_PRINCIPAL_KEY: public in the repo, so it must never sign for real.
  'commerceworker-local-dev-principal-key',
]);

const MIN_SECRET_LENGTH = 32;

/** SHA-256 hasher with optional server-side pepper (defense in depth at rest). */
export function createHasher(pepper?: string): Hasher {
  const prefix = pepper ?? '';
  return {
    hash: (value: string) =>
      createHash('sha256')
        .update(prefix + value)
        .digest('hex'),
  };
}

/** Constant-time comparison for bearer secrets (admin/MCP tokens). */
export function secureTokenEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export interface SecureSecretsInput {
  readonly requireSecureSecrets: boolean;
  readonly seedDev: boolean;
  readonly adminToken: string;
  readonly mcpToken?: string;
  readonly cmaKey?: string;
  readonly cdaKey?: string;
  readonly cpaKey?: string;
  /** HMAC secret for admin SSO session cookies; pass only when OIDC is enabled. */
  readonly sessionSecret?: string;
  /** PRINCIPAL_KEY and PRINCIPAL_KEY_PREVIOUS: anyone holding one can act as any person. */
  readonly principalKeys?: readonly string[];
}

/**
 * Fail fast when production (or REQUIRE_SECURE_SECRETS) would run with known
 * weak credentials. Call at process startup in API and MCP servers.
 */
export function assertSecureSecrets(input: SecureSecretsInput): void {
  if (!input.requireSecureSecrets) return;

  const errors: string[] = [];

  if (input.seedDev) {
    errors.push('SEED_DEV must not be true when secure secrets are required');
  }

  for (const [name, value] of [
    ['ADMIN_TOKEN', input.adminToken],
    ['MCP_TOKEN', input.mcpToken],
    ['CMA_KEY', input.cmaKey],
    ['CDA_KEY', input.cdaKey],
    ['CPA_KEY', input.cpaKey],
    ['SESSION_SECRET', input.sessionSecret],
    ...(input.principalKeys ?? []).map(
      (k, i) => [i === 0 ? 'PRINCIPAL_KEY' : 'PRINCIPAL_KEY_PREVIOUS', k] as const,
    ),
  ] as const) {
    if (!value) continue;
    if (DEV_TOKEN_DEFAULTS.has(value)) {
      errors.push(`${name} must not use a known dev default`);
    }
    if (value.length < MIN_SECRET_LENGTH) {
      errors.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }

  if (input.adminToken && input.mcpToken && input.adminToken === input.mcpToken) {
    errors.push('ADMIN_TOKEN and MCP_TOKEN must differ');
  }

  if (errors.length > 0) {
    throw new Error(`Insecure configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

export function requireSecureSecretsFromEnv(env: NodeJS.ProcessEnv): boolean {
  if (env.REQUIRE_SECURE_SECRETS === 'false') return false;
  return env.REQUIRE_SECURE_SECRETS === 'true' || env.NODE_ENV === 'production';
}
