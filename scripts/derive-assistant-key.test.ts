import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  DEV_ASSISTANT_PRINCIPAL_KEY,
  deriveAssistantPrincipalKey,
} from '../packages/security/src/assistant-key.ts';
import { deriveAssistantKey } from './derive-assistant-key.ts';

// Known answer, computed independently (RFC 5869 written out over HMAC-SHA256).
const KEY = '0123456789abcdef0123456789abcdef';
const KNOWN = 'A4mLFLoVP7P-HbyQb2RgsJUGXyCj4FhkOg_mZQ-N9Tw';

test('node:crypto and WebCrypto derive the same assistant key', async () => {
  assert.equal(deriveAssistantKey(KEY), KNOWN);
  for (const k of [KEY, 'commerceworker-local-dev-principal-key', 'x'.repeat(64)])
    assert.equal(deriveAssistantKey(k), await deriveAssistantPrincipalKey(k));
  assert.equal(
    deriveAssistantKey('commerceworker-local-dev-principal-key'),
    DEV_ASSISTANT_PRINCIPAL_KEY,
  );
});

test('the script reads the key from stdin or the environment, never an argument', () => {
  const run = (input: string | undefined, env: Record<string, string> = {}) =>
    execFileSync(process.execPath, ['scripts/derive-assistant-key.ts'], {
      input,
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });
  assert.equal(run(`${KEY}\n`), KNOWN);
  assert.equal(run('', { PRINCIPAL_KEY: KEY }), KNOWN);
  assert.throws(() => run('', {}), /PRINCIPAL_KEY is not set/);
});
