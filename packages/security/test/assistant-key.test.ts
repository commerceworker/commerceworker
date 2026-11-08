import { describe, expect, it } from 'vitest';
import {
  DEV_ASSISTANT_PRINCIPAL_KEY,
  deriveAssistantPrincipalKey,
  isAssistantPrincipalPath,
} from '../src/assistant-key';
import { DEV_PRINCIPAL_KEY, signPrincipal, verifyPrincipal } from '../src/principal';

// Known answer, computed independently (RFC 5869 written out over HMAC-SHA256).
const KEY = '0123456789abcdef0123456789abcdef';
const KNOWN = 'A4mLFLoVP7P-HbyQb2RgsJUGXyCj4FhkOg_mZQ-N9Tw';

describe('the assistant’s principal key', () => {
  it('is HKDF-SHA256 of PRINCIPAL_KEY with the fixed salt and info, as base64url', async () => {
    expect(await deriveAssistantPrincipalKey(KEY)).toBe(KNOWN);
    expect(await deriveAssistantPrincipalKey(DEV_PRINCIPAL_KEY)).toBe(DEV_ASSISTANT_PRINCIPAL_KEY);
  });

  it('differs from the key it came from and from another key’s, and is refused without one', async () => {
    const a = await deriveAssistantPrincipalKey(KEY);
    expect(a).not.toBe(KEY);
    expect(await deriveAssistantPrincipalKey(`${KEY}x`)).not.toBe(a);
    await expect(deriveAssistantPrincipalKey('')).rejects.toThrow(/PRINCIPAL_KEY/);
  });

  it('signs principals the main key doesn’t verify, and the reverse', async () => {
    const ada = { sub: 'usr_ada', email: 'a@example.com', name: 'Ada', role: 'admin' as const };
    const sub = await deriveAssistantPrincipalKey(KEY);
    const path = '/agents/assistant-agent/usr_ada';
    expect(await verifyPrincipal(KEY, await signPrincipal(sub, ada, path), path)).toBeNull();
    expect(await verifyPrincipal(sub, await signPrincipal(KEY, ada, path), path)).toBeNull();
    expect(await verifyPrincipal(sub, await signPrincipal(sub, ada, path), path)).toEqual(ada);
  });

  it('is for the assistant’s paths only', () => {
    expect(isAssistantPrincipalPath('/agents/assistant-agent/usr_ada')).toBe(true);
    expect(isAssistantPrincipalPath('/agents/assistant-agent/usr_ada/get-messages')).toBe(true);
    expect(isAssistantPrincipalPath('/spaces/s1/entries')).toBe(false);
    expect(isAssistantPrincipalPath('/agentsx')).toBe(false);
    // As the web gateway signs it: for the method and path.
    expect(isAssistantPrincipalPath('GET /agents/assistant-agent/usr_ada')).toBe(true);
    expect(isAssistantPrincipalPath('POST /spaces/s1/entries')).toBe(false);
    expect(isAssistantPrincipalPath('GET /spaces/agents/x')).toBe(false);
  });
});
