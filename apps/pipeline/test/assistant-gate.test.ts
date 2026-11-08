import { assistantName, routeAssistant } from '@commerceworker/http/assistant/gate';
import type { EdgeEnv } from '@commerceworker/platform/env';
import { deriveAssistantPrincipalKey } from '@commerceworker/security/assistant-key';
import {
  PRINCIPAL_HEADER,
  principalTarget,
  signPrincipal,
} from '@commerceworker/security/principal';
import { describe, expect, it } from 'vitest';

const KEY = 'gate-test-principal-key-0123456789abcdef';
const ada = {
  sub: 'usr_ada',
  email: 'ada@example.com',
  name: 'Ada',
  role: 'admin' as const,
  sid: 's1',
};

/** An env whose assistant namespace records what reached the object. */
function envSeeing() {
  const seen: Request[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (r: Request) => {
        seen.push(r);
        return new Response('[]');
      },
    }),
  };
  return {
    env: { PRINCIPAL_KEY: KEY, ASSISTANT_AGENT: namespace } as unknown as EdgeEnv,
    seen,
  };
}

describe('the assistant’s gate', () => {
  it('forwards its own person, without the SDK’s internal headers a caller sent', async () => {
    const { env, seen } = envSeeing();
    const path = '/agents/assistant-agent/usr_ada/get-messages';
    const res = await routeAssistant(
      new Request(`https://api${path}`, {
        headers: {
          [PRINCIPAL_HEADER]: await signPrincipal(
            await deriveAssistantPrincipalKey(KEY),
            ada,
            principalTarget('GET', path),
          ),
          'x-agents-lifecycle-props': 'eyJmb3JnZWQiOnRydWV9',
          'x-partykit-room': 'usr_bob',
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get('x-agents-lifecycle-props')).toBeNull();
    expect(seen[0]!.headers.get('x-partykit-room')).toBeNull();
  });

  it('accepts the key derived for the assistant, and refuses the main key', async () => {
    const path = '/agents/assistant-agent/usr_ada/get-messages';
    for (const key of [await deriveAssistantPrincipalKey(KEY)]) {
      const { env, seen } = envSeeing();
      const res = await routeAssistant(
        new Request(`https://api${path}`, {
          headers: {
            [PRINCIPAL_HEADER]: await signPrincipal(key, ada, principalTarget('GET', path)),
          },
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
    }
    // The main key itself is refused on the assistant's paths.
    {
      const { env, seen } = envSeeing();
      const res = await routeAssistant(
        new Request(`https://api${path}`, {
          headers: {
            [PRINCIPAL_HEADER]: await signPrincipal(KEY, ada, principalTarget('GET', path)),
          },
        }),
        env,
      );
      expect(res.status).toBe(401);
      expect(seen).toHaveLength(0);
    }
    // A key derived from anything else is refused.
    const { env } = envSeeing();
    const other = await deriveAssistantPrincipalKey('another-principal-key-0123456789abcdef');
    const res = await routeAssistant(
      new Request(`https://api${path}`, {
        headers: {
          [PRINCIPAL_HEADER]: await signPrincipal(other, ada, principalTarget('GET', path)),
        },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('refuses another person’s assistant before anything reaches it', async () => {
    const { env, seen } = envSeeing();
    const path = '/agents/assistant-agent/usr_bob/get-messages';
    const res = await routeAssistant(
      new Request(`https://api${path}`, {
        headers: {
          [PRINCIPAL_HEADER]: await signPrincipal(
            await deriveAssistantPrincipalKey(KEY),
            ada,
            principalTarget('GET', path),
          ),
        },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('reads only a well-formed person from the path', () => {
    expect(assistantName('/agents/assistant-agent/usr_ada')).toBe('usr_ada');
    expect(assistantName('/agents/assistant-agent/%E0%A4%A')).toBeNull();
    expect(assistantName('/agents/live-hub/usr_ada')).toBeNull();
  });
});
