/**
 * Prints the assistant's principal key for a PRINCIPAL_KEY (HKDF-SHA256, as
 * `deriveAssistantPrincipalKey` in @commerceworker/security derives it with WebCrypto).
 *
 *   printf %s "$PRINCIPAL_KEY" | node scripts/derive-assistant-key.ts
 *   PRINCIPAL_KEY=… node scripts/derive-assistant-key.ts
 *
 * The key comes from stdin or the PRINCIPAL_KEY variable, never an argument (arguments show up in
 * process listings and shell history). `fleet.ts secrets` derives the engine's pair the same way.
 */
import { hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ASSISTANT_KEY_BYTES,
  ASSISTANT_KEY_INFO,
  ASSISTANT_KEY_SALT,
} from '../packages/security/src/assistant-key.ts';

/** The assistant's principal key for `secret`, as base64url. */
export function deriveAssistantKey(secret: string): string {
  if (!secret) throw new Error('PRINCIPAL_KEY is not set');
  return Buffer.from(
    hkdfSync('sha256', secret, ASSISTANT_KEY_SALT, ASSISTANT_KEY_INFO, ASSISTANT_KEY_BYTES),
  ).toString('base64url');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const secret = process.stdin.isTTY
    ? (process.env.PRINCIPAL_KEY ?? '')
    : readFileSync(0, 'utf8').replace(/\r?\n$/, '') || (process.env.PRINCIPAL_KEY ?? '');
  try {
    process.stdout.write(deriveAssistantKey(secret));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
